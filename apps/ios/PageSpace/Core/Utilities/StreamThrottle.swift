//
//  StreamThrottle.swift
//  PageSpace
//
//  Created for throttling rapid stream updates to prevent SwiftUI frame overload
//

import Foundation

/// Throttles rapid function calls by batching them with a specified interval.
/// Useful for streaming scenarios where updates arrive faster than the UI can render.
///
/// This class is fully thread-safe and can be called from any thread. All state access
/// is protected by an internal serial queue, ensuring atomic operations without race conditions.
///
/// Example usage:
/// ```swift
/// let throttle = StreamThrottle(interval: 0.05) // 50ms
/// throttle.execute {
///     self.updateUI()
/// }
/// ```
///
/// - Important: Actions are executed on the queue specified during initialization (main queue by default).
///   The throttle batches rapid calls into a single execution after the specified interval.
final class StreamThrottle {
    // Isolation queue ensures thread-safe access to mutable state
    private let isolationQueue = DispatchQueue(label: "com.pagespace.streamthrottle", qos: .userInitiated)

    private let interval: TimeInterval
    private let executionQueue: DispatchQueue

    // Protected by isolationQueue
    private var workItem: DispatchWorkItem?

    /// Creates a new throttle instance
    /// - Parameters:
    ///   - interval: Time interval in seconds to batch updates (default: 0.05 = 50ms)
    ///   - queue: Dispatch queue to execute actions on (default: main queue)
    init(interval: TimeInterval = 0.05, queue: DispatchQueue = .main) {
        self.interval = interval
        self.executionQueue = queue
    }

    /// Schedules a closure to be executed after the throttle interval.
    /// If called again before the interval expires, the previous call is cancelled.
    ///
    /// This method is thread-safe and can be called from any thread.
    ///
    /// - Parameter action: The closure to execute. Will be called on the execution queue specified in init.
    func execute(_ action: @escaping () -> Void) {
        isolationQueue.async { [weak self] in
            guard let self = self else { return }

            // Cancel any pending execution
            self.workItem?.cancel()

            // Create new work item with identity validation
            // Using implicitly unwrapped optional to allow self-reference in closure
            var workItemRef: DispatchWorkItem!
            workItemRef = DispatchWorkItem { [weak self] in
                guard let self = self else { return }

                // Verify this is still the current work item (prevents stale execution)
                var shouldExecute = false
                self.isolationQueue.sync {
                    shouldExecute = self.workItem === workItemRef
                }

                guard shouldExecute else { return }
                action()
            }

            // Store and schedule the new work item
            self.workItem = workItemRef
            self.executionQueue.asyncAfter(deadline: .now() + self.interval, execute: workItemRef)
        }
    }

    /// Cancels any pending execution.
    ///
    /// This method is thread-safe and can be called from any thread.
    func cancel() {
        isolationQueue.async { [weak self] in
            guard let self = self else { return }
            self.workItem?.cancel()
            self.workItem = nil
        }
    }

    /// Immediately executes any pending work and cancels the scheduled timer.
    ///
    /// This method is thread-safe and can be called from any thread.
    /// The pending action will be executed on the execution queue if one exists.
    func flush() {
        isolationQueue.async { [weak self] in
            guard let self = self else { return }
            guard let item = self.workItem, !item.isCancelled else { return }

            // Cancel the scheduled execution
            item.cancel()

            // Execute immediately on the execution queue
            self.executionQueue.async { [weak self] in
                guard self != nil else { return }
                item.perform()
            }

            // Clear the work item
            self.workItem = nil
        }
    }

    deinit {
        // Clean up any pending work
        workItem?.cancel()
    }
}
