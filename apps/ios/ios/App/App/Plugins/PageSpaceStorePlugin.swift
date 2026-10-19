import Capacitor
import StoreKit
import UIKit

/// StoreKit 2 bridge for Apple In-App Purchases (jsName `PageSpaceStore`).
///
/// The web layer drives the flow: it asks the server for an `appAccountToken`, calls
/// `purchase`, posts the returned JWS to `/api/iap/apple/transactions`, and only then calls
/// `finish`. This plugin never finishes a transaction on its own — an unfinished transaction
/// is redelivered by StoreKit, which is what makes a failed server call recoverable.
///
/// Only `.verified` StoreKit results are ever surfaced to JS; `.unverified` ones are rejected
/// (purchase) or skipped (lists, updates). The server re-verifies every JWS regardless.
@objc(PageSpaceStorePlugin)
public class PageSpaceStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PageSpaceStorePlugin"
    public let jsName = "PageSpaceStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise)
    ]

    static let transactionUpdatedEvent = "transactionUpdated"

    /// Verified transactions surfaced to JS and not yet finished, keyed by transaction id.
    private let pending = PendingTransactions()
    private var updatesTask: Task<Void, Never>?

    override public func load() {
        updatesTask = Task.detached(priority: .background) { [weak self] in
            for await result in Transaction.updates {
                guard let self = self else { return }
                guard let payload = await self.surface(result) else { continue }
                await MainActor.run {
                    self.notifyListeners(PageSpaceStorePlugin.transactionUpdatedEvent, data: payload, retainUntilConsumed: true)
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    // MARK: - Methods

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let raw = call.getArray("productIds") else {
            call.reject("Missing productIds")
            return
        }
        let ids = raw.compactMap { $0 as? String }
        Task {
            do {
                let products = try await Product.products(for: ids)
                call.resolve(["products": products.map(Self.serialize(product:))])
            } catch {
                call.reject("Failed to load products: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("Missing productId")
            return
        }
        guard let tokenString = call.getString("appAccountToken"),
              let token = UUID(uuidString: tokenString) else {
            call.reject("appAccountToken must be a UUID")
            return
        }
        Task {
            do {
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("Unknown product: \(productId)")
                    return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verification):
                    guard let payload = await self.surface(verification) else {
                        call.reject("Transaction failed verification")
                        return
                    }
                    var response = payload
                    response["status"] = "success"
                    call.resolve(response)
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    call.resolve(["status": "pending"])
                @unknown default:
                    call.reject("Unknown purchase result")
                }
            } catch {
                call.reject("Purchase failed: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let transactionId = call.getString("transactionId"), !transactionId.isEmpty else {
            call.reject("Missing transactionId")
            return
        }
        Task {
            if let transaction = await self.pending.take(transactionId) {
                await transaction.finish()
                call.resolve([:])
                return
            }
            // Not surfaced in this session (e.g. a previous launch): look it up in the queue.
            for await result in Transaction.unfinished {
                guard case .verified(let transaction) = result,
                      String(transaction.id) == transactionId else { continue }
                await transaction.finish()
                break
            }
            call.resolve([:])
        }
    }

    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task {
            call.resolve(["transactions": await self.collect(Transaction.currentEntitlements)])
        }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            call.resolve(["transactions": await self.collect(Transaction.unfinished)])
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                try await AppStore.sync()
            } catch {
                call.reject("Restore failed: \(error.localizedDescription)", nil, error)
                return
            }
            call.resolve(["transactions": await self.collect(Transaction.currentEntitlements)])
        }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = self.bridge?.viewController?.view.window?.windowScene else {
                call.reject("No active window scene")
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve([:])
            } catch {
                call.reject("Could not open subscription management: \(error.localizedDescription)", nil, error)
            }
        }
    }

    // MARK: - Helpers

    /// Caches a verified transaction for `finish` and returns its JS payload; nil if unverified.
    private func surface(_ result: VerificationResult<Transaction>) async -> [String: Any]? {
        guard case .verified(let transaction) = result else { return nil }
        let id = String(transaction.id)
        await pending.put(id, transaction)
        return ["jws": result.jwsRepresentation, "transactionId": id]
    }

    private func collect(_ sequence: Transaction.Transactions) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for await result in sequence {
            if let payload = await surface(result) {
                out.append(payload)
            }
        }
        return out
    }

    private static func serialize(product: Product) -> [String: Any] {
        var out: [String: Any] = [
            "id": product.id,
            "displayName": product.displayName,
            "description": product.description,
            "displayPrice": product.displayPrice,
            "price": NSDecimalNumber(decimal: product.price).stringValue,
            "currencyCode": product.priceFormatStyle.currencyCode,
            "type": typeName(product.type)
        ]
        if let period = product.subscription?.subscriptionPeriod {
            out["subscriptionPeriod"] = [
                "unit": unitName(period.unit),
                "value": period.value
            ]
        }
        return out
    }

    private static func typeName(_ type: Product.ProductType) -> String {
        switch type {
        case .autoRenewable: return "autoRenewable"
        case .consumable: return "consumable"
        case .nonConsumable: return "nonConsumable"
        case .nonRenewable: return "nonRenewable"
        default: return "nonConsumable"
        }
    }

    private static func unitName(_ unit: Product.SubscriptionPeriod.Unit) -> String {
        switch unit {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        @unknown default: return "month"
        }
    }
}

/// Serializes access to surfaced-but-unfinished transactions across concurrent tasks.
private actor PendingTransactions {
    private var byId: [String: Transaction] = [:]

    func put(_ id: String, _ transaction: Transaction) {
        byId[id] = transaction
    }

    func take(_ id: String) -> Transaction? {
        byId.removeValue(forKey: id)
    }
}
