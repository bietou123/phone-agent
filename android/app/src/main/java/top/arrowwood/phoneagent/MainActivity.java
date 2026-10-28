package top.arrowwood.phoneagent;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TermuxBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
