package uk.co.sonor.skyremote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SkyTcpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
