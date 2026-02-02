package ai.pagespace.android;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Zero-trust secure storage plugin using Android EncryptedSharedPreferences.
 * Provides the same JS interface as the iOS PageSpaceKeychainPlugin.
 *
 * Security properties:
 * - AES-256-GCM encryption for values
 * - AES-256-SIV encryption for keys
 * - Android Keystore-backed master key
 * - Hardware security module used when available
 * - No cloud sync - data stays on device
 */
@CapacitorPlugin(name = "PageSpaceKeychain")
public class PageSpaceSecureStoragePlugin extends Plugin {
    private SharedPreferences sharedPreferences;
    private String initializationError;
    private static final String PREFS_NAME = "ai.pagespace.secure";

    @Override
    public void load() {
        try {
            Context context = getContext();
            MasterKey masterKey = new MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();

            sharedPreferences = EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
            initializationError = null;
        } catch (Exception e) {
            sharedPreferences = null;
            initializationError = "Secure storage unavailable: " + e.getMessage();
        }
    }

    private boolean rejectIfNotInitialized(PluginCall call) {
        if (sharedPreferences == null) {
            call.reject(initializationError != null ? initializationError : "Secure storage not initialized");
            return true;
        }
        return false;
    }

    @PluginMethod
    public void get(PluginCall call) {
        if (rejectIfNotInitialized(call)) return;
        String key = call.getString("key");
        if (key == null) {
            call.reject("Missing key");
            return;
        }
        String value = sharedPreferences.getString(key, null);
        JSObject result = new JSObject();
        result.put("value", value);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        if (rejectIfNotInitialized(call)) return;
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("Missing key or value");
            return;
        }
        sharedPreferences.edit().putString(key, value).apply();
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        if (rejectIfNotInitialized(call)) return;
        String key = call.getString("key");
        if (key == null) {
            call.reject("Missing key");
            return;
        }
        sharedPreferences.edit().remove(key).apply();
        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }
}
