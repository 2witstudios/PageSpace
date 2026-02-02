package ai.pagespace.android;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PageSpaceSecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
