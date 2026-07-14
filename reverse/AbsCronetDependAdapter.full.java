package com.bytedance.ttnet.cronet;

import X.0Exj;
import X.0Tpp;
import X.0llP;
import X.0lvx;
import X.0lvy;
import X.0lvz;
import X.AbstractC11840uIn;
import X.C22540ujv;
import X.C22930ukY;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.text.TextUtils;
import android.util.Pair;
import com.bytedance.aweme.coffee.json.JSONTokenerGetter;
import com.bytedance.common.utility.Logger;
import com.bytedance.common.utility.NetworkUtils;
import com.bytedance.common.utility.StringUtils;
import com.bytedance.common.utility.UIUtils;
import com.bytedance.common.utility.concurrent.ThreadPlus;
import com.bytedance.frameworks.baselib.network.http.NetworkParams;
import com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider;
import com.bytedance.frameworks.baselib.network.http.cronet.ICronetDepend;
import com.bytedance.frameworks.baselib.network.utils.ReflectWrap;
import com.bytedance.memoryx.StringBuilderCache;
import com.bytedance.mt.protector.impl.JSONObjectProtectorUtils;
import com.bytedance.ttnet.TTMultiNetwork;
import com.bytedance.ttnet.TTNetInit;
import com.bytedance.ttnet.TTWiFiCellSwitcher;
import com.bytedance.ttnet.cronet.AbsCronetDependAdapter;
import com.bytedance.ttnet.tnc.TNCManager;
import com.huawei.hms.kit.awareness.b.b;
import com.ss.android.ugc.aweme.keva.KevaSpAopHook;
import com.ss.android.ugc.bytex.async.stack.broken_chain.CallbackRunnable;
import com.ss.android.ugc.bytex.async.stack.transmitter.AsyncContext;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/* loaded from: E:\douyin-golden-goose-crawler\reverse\partial_dex\classes27.dex */
public abstract class AbsCronetDependAdapter implements ICronetDepend, ICronetAppProvider {
    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void doLoadLibrary(String str) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAbClient() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAbFeature() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAbFlag() {
        return "-1";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public List<String> getAbSdkVersion() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAbVersion() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAppId() {
        return "-1";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAppInitialRegionInfo() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAppName() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public long getAppStartTime() {
        return -1L;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getBypassBOEJSON() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getCarrierRegion() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getChannel() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getCityName() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String[], Pair<byte[], byte[]>> getClientOpaqueData() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDeviceId() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDevicePlatform() {
        return "android";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getGetDomainDefaultJSON() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getHttpDnsRequestFlags() {
        return "0";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getIId() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getIsDropFirstTnc() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getLanguage() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean getLazyInitCronetIPC() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getManifestVersionCode() {
        return "-1";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public ArrayList<byte[]> getOpaqueData() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getOpenUdid() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean getOptInit() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean getOptNqeDefault() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean getOptNqePersist() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String, Pair<Integer, Integer>> getQuicHint() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getRegion() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getSdkAppId() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getSdkVersion() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetDepend
    public String getSsCookieKey() {
        return "X-SS-Cookie";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getSsmix() {
        return "a";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getStoreIdc() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getStoreIdcRuleJSON() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getSysRegion() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getTNCRequestFlags() {
        return "0";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String, String> getTNCRequestHeader() {
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getUUID() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getUpdateVersionCode() {
        return "-1";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getUserId() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getVersionCode() {
        return "-1";
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getVersionName() {
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean isBOEProxyEnabled() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean isEnableBrotli() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean isEnableHttp2() {
        return true;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean isEnableQuic() {
        return false;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetDepend
    public void loggerD(String str, String str2) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public boolean needCustomLoadLibrary() {
        return false;
    }

    public void onCronetMappingRequestStatus(String str, int i) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onEffectiveConnectionTypeChanged(int i) {
    }

    public void onNQEEffectiveConnectionTypeChanged(int i) {
    }

    public void onNQEPacketLossComputed(int i, double d, double d2, double d3, double d4) {
    }

    public void onNQERTTOrThroughputComputed(int i, int i2, int i3) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onNetworkQualityLevelChanged(int i) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onNetworkQualityRttAndThroughputNotified(int i, int i2, int i3) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onPacketLossComputed(int i, double d, double d2, double d3, double d4) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onRTTOrThroughputEstimatesComputed(int i, int i2, int i3) {
    }

    public void onTTNetDetectResult(String str) {
    }

    public void onTTNetworkStateChanged(int i) {
    }

    public void onWiFiToCellStateChangedForApp(int i, int i2) {
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void sendAppMonitorEvent(String str, String str2) {
    }

    /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDeviceBrand() {
        return Build.BRAND;
    }

    /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDeviceModel() {
        return Build.MODEL;
    }

    /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDeviceType() {
        return Build.MODEL;
    }

    /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onCronetBootSucceed() {
        Logger.debug();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getAbi() {
        return Build.SUPPORTED_ABIS[0];
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getNetworkOperator() {
        TTNetInit.getSystemApiSandbox();
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getOSApi() {
        return String.valueOf(Build.VERSION.SDK_INT);
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final int getProcessFlag() {
        return 0Exj.LIZ.get();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getSimOperator() {
        TTNetInit.getSystemApiSandbox();
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public int getWifiFrequency() {
        TTNetInit.getSystemApiSandbox();
        return 0;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public int getWifiRssi() {
        TTNetInit.getSystemApiSandbox();
        return 0;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetDepend
    public boolean loggerDebug() {
        return Logger.debug();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getCronetSoPath() {
        return C22540ujv.LJIIIZ(TTNetInit.getTTNetDepend().getContext()).n;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getNetAccessType() {
        return NetworkUtils.getNetworkAccessType(TTNetInit.getTTNetDepend().getContext());
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getRticket() {
        return String.valueOf(System.currentTimeMillis());
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onColdStartFinish() {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukf
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                TTNetInit.notifyColdStartFinish();
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getDPI() {
        int dpi = UIUtils.getDpi(TTNetInit.getTTNetDepend().getContext());
        if (dpi > 0) {
            return String.valueOf(dpi);
        }
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getOSVersion() {
        try {
            String str = Build.VERSION.RELEASE;
            if (str != null && str.length() > 10) {
                return str.substring(0, 10);
            }
            return str;
        } catch (Exception unused) {
            return b.d;
        }
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public String getResolution() {
        String LIZIZ = UIUtils.LIZIZ(TTNetInit.getTTNetDepend().getContext());
        if (!StringUtils.isEmpty(LIZIZ)) {
            return LIZIZ;
        }
        return b.d;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String, String> getTNCRequestQuery() {
        Object tTNetDepend = TTNetInit.getTTNetDepend();
        if (tTNetDepend != null && (tTNetDepend instanceof AbstractC11840uIn)) {
            ((AbstractC11840uIn) tTNetDepend).LJIILJJIL();
        }
        return null;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String, String> getGetDomainDependHostMap() {
        LinkedHashMap linkedHashMap = new LinkedHashMap();
        TTNetInit.getTTNetDepend().LIZIZ();
        String[] strArr = 0llP.LIZIZ;
        if (strArr.length > 0) {
            linkedHashMap.put("first", strArr[0]);
        }
        if (strArr.length > 1) {
            linkedHashMap.put("second", strArr[1]);
        }
        if (strArr.length > 2) {
            linkedHashMap.put("third", strArr[2]);
        }
        Map<String, String> LJIILIIL = TTNetInit.getTTNetDepend().LJIILIIL();
        if (TextUtils.isEmpty(LJIILIIL.get("httpdns")) || (TextUtils.isEmpty(LJIILIIL.get("boe")) && TextUtils.isEmpty(LJIILIIL.get("boe_https")))) {
            throw new IllegalArgumentException("You must set HttpDns, NetLog and BOE service domain, please refer to TTNet access documents.");
        }
        linkedHashMap.putAll(LJIILIIL);
        return linkedHashMap;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public C22930ukY getAppInfoSubset() {
        C22930ukY c22930ukY = new C22930ukY();
        List<String> abSdkVersion = getAbSdkVersion();
        String str = b.d;
        if (abSdkVersion != null) {
            int i = 0;
            for (String str2 : abSdkVersion) {
                i++;
                if (i > 5) {
                    break;
                }
                if (!TextUtils.isEmpty(str2)) {
                    StringBuilder sb = StringBuilderCache.get();
                    sb.append(str);
                    sb.append(str2);
                    sb.append(",");
                    str = StringBuilderCache.release(sb);
                }
            }
        }
        c22930ukY.LIZ = str;
        TTNetInit.getTTNetDepend().LIZIZ();
        String[] strArr = 0llP.LIZIZ;
        if (strArr.length > 0) {
            c22930ukY.LIZIZ = strArr[0];
        }
        if (strArr.length > 1) {
            c22930ukY.LIZJ = strArr[1];
        }
        if (strArr.length > 2) {
            c22930ukY.LIZLLL = strArr[2];
        }
        Map<String, String> LJIILIIL = TTNetInit.getTTNetDepend().LJIILIIL();
        String str3 = LJIILIIL.get("httpdns");
        if (str3 != null && !TextUtils.isEmpty(str3)) {
            c22930ukY.LJ = str3;
        }
        String str4 = LJIILIIL.get("boe");
        if (str4 != null && !TextUtils.isEmpty(str4)) {
            c22930ukY.LJFF = str4;
        }
        String str5 = LJIILIIL.get("boe_https");
        if (str5 != null && !TextUtils.isEmpty(str5)) {
            c22930ukY.LJI = str5;
        }
        c22930ukY.LJII = getAppInitialRegionInfo();
        return c22930ukY;
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onClientIPChanged(final String str) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukg
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                TTNetInit.onClientIPChanged(str);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onEffectiveConnectionTypeChangedOnIOThread(int i) {
        Logger.debug();
        new 0lvy(this, i).start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onNetworkQualityLevelChangedOnIOThread(final int i) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukd
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                AbsCronetDependAdapter.this.onNetworkQualityLevelChanged(i);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onServerConfigABTestChanged(final String str) {
        try {
            new ThreadPlus() { // from class: X.0ukP
                public AsyncContext _async_context;
                public CallbackRunnable _d_p;

                @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
                public final void run() {
                    try {
                        C22540ujv.LJIIIZ(TTNetInit.getTTNetDepend().getContext()).LJIILLIIL(str);
                    } catch (Throwable unused) {
                    }
                }
            }.start();
        } catch (Throwable unused) {
        }
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onServerConfigEtagChanged(final String str) {
        try {
            new ThreadPlus() { // from class: X.0ukQ
                public AsyncContext _async_context;
                public CallbackRunnable _d_p;

                @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
                public final void run() {
                    try {
                        C22540ujv.LJIIIZ(TTNetInit.getTTNetDepend().getContext()).r = str;
                    } catch (Throwable unused) {
                    }
                }
            }.start();
        } catch (Throwable unused) {
        }
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onServerConfigUpdated(String str) {
        try {
            Logger.debug();
            new 0lvx(str).start();
        } catch (Throwable unused) {
        }
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onTTNetDetectInfoChanged(String str) {
        Logger.debug();
        new 0lvz(this, str).start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onUserSpecifiedNetworkEnabled(final boolean z) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukT
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                try {
                    ReflectWrap.LIZ(TTMultiNetwork.class).call("notifyUserSpecifiedNetworkEnabled", new Class[]{Boolean.TYPE}, new Object[]{Boolean.valueOf(z)});
                } catch (Throwable unused) {
                }
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onDropReasonChanged(final boolean z, final List<Integer> list) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0uGN
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                if (C0uGM.LIZJ == null) {
                    synchronized (C0uGM.class) {
                        if (C0uGM.LIZJ == null) {
                            C0uGM.LIZJ = new C0uGM();
                        }
                    }
                }
                C0uGM.LIZJ.LIZ(z, list);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onMappingRequestStatus(final String str, final int i) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0uki
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                AbsCronetDependAdapter.this.onCronetMappingRequestStatus(str, i);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onMultiNetworkStateChanged(final int i, final int i2) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukS
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                try {
                    0FwQ LIZ = ReflectWrap.LIZ(TTMultiNetwork.class);
                    Class cls = Integer.TYPE;
                    LIZ.call("notifyMultiNetworkState", new Class[]{cls, cls}, new Object[]{Integer.valueOf(i), Integer.valueOf(i2)});
                } catch (Throwable unused) {
                }
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onPublicIPsChanged(final List<String> list, final List<String> list2) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukh
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                TTNetInit.onPublicIPsChanged(list, list2);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onTNCUpdateFailed(final ArrayList<String> arrayList, final String str) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ujs
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                Context context;
                String str2;
                String str3;
                String str4;
                String str5;
                if (C23200ukz.LIZ == null) {
                    synchronized (C23200ukz.class) {
                        if (C23200ukz.LIZ == null) {
                            C23200ukz.LIZ = new C23200ukz();
                        }
                    }
                }
                C23200ukz c23200ukz = C23200ukz.LIZ;
                ArrayList arrayList2 = arrayList;
                String str6 = str;
                c23200ukz.getClass();
                if (arrayList2 != null && !arrayList2.isEmpty() && (context = TTNetInit.getTTNetDepend().getContext()) != null) {
                    Logger.debug();
                    Iterator LLJLLL = 0Tpp.LLJLLL(arrayList2);
                    while (LLJLLL.hasNext()) {
                        String str7 = (String) LLJLLL.next();
                        try {
                            C22940ukZ c22940ukZ = new C22940ukZ();
                            c22940ukZ.LIZIZ = true;
                            c22940ukZ.LIZJ = false;
                            04PH r4 = new 04PH(str7);
                            r4.LIZIZ("tnc_src", "7");
                            String LIZJ = r4.LIZJ();
                            HashMap hashMap = new HashMap();
                            HashMap hashMap2 = new HashMap();
                            if (!TextUtils.isEmpty(str6)) {
                                hashMap2.put("x-tt-tnc-summary", str6);
                            }
                            TNCManager.LJI().getClass();
                            String LIZ = C22560ujx.LIZ(LIZJ, hashMap2, hashMap, c22940ukZ);
                            Logger.debug();
                            TNCManager.LJI().getClass();
                            if (!StringUtils.isEmpty(LIZ) && "success".equals(JSONObjectProtectorUtils.LJI("message", new JSONObject(JSONTokenerGetter.get(LIZ))))) {
                                try {
                                    Object obj = hashMap.get("x-ss-etag");
                                    String str8 = b.d;
                                    if (obj == null || TextUtils.isEmpty((CharSequence) ((List) hashMap.get("x-ss-etag")).get(0))) {
                                        str2 = b.d;
                                    } else {
                                        str2 = (String) ((List) hashMap.get("x-ss-etag")).get(0);
                                    }
                                    if (hashMap.get("x-ss-canary") != null && !TextUtils.isEmpty((CharSequence) ((List) hashMap.get("x-ss-canary")).get(0))) {
                                        str3 = (String) ((List) hashMap.get("x-ss-canary")).get(0);
                                    } else {
                                        str3 = b.d;
                                    }
                                    if (hashMap.get("x-tt-tnc-config") != null && !TextUtils.isEmpty((CharSequence) ((List) hashMap.get("x-tt-tnc-config")).get(0))) {
                                        str4 = (String) ((List) hashMap.get("x-tt-tnc-config")).get(0);
                                    } else {
                                        str4 = b.d;
                                    }
                                    if (hashMap.get("x-tt-tnc-abtest") != null && !TextUtils.isEmpty((CharSequence) ((List) hashMap.get("x-tt-tnc-abtest")).get(0))) {
                                        str5 = (String) ((List) hashMap.get("x-tt-tnc-abtest")).get(0);
                                    } else {
                                        str5 = b.d;
                                    }
                                    if (hashMap.get("x-tt-tnc-control") != null && !TextUtils.isEmpty((CharSequence) ((List) hashMap.get("x-tt-tnc-control")).get(0))) {
                                        str8 = (String) ((List) hashMap.get("x-tt-tnc-control")).get(0);
                                    }
                                    Logger.debug();
                                    C22550ujw.LJ(context).getClass();
                                    C22550ujw.LIZIZ();
                                    C22550ujw.LIZJ.notifyTNCConfigUpdated(str2, str3, str4, str5, str8, LIZ);
                                    return;
                                } catch (Throwable unused) {
                                    return;
                                }
                            }
                        } catch (Throwable unused2) {
                        }
                    }
                }
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onWiFiToCellStateChanged(final int i, final int i2) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukR
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                try {
                    0FwQ LIZ = ReflectWrap.LIZ(TTWiFiCellSwitcher.class);
                    Class cls = Integer.TYPE;
                    LIZ.call("notifyWiFiToCellState", new Class[]{cls, cls}, new Object[]{Integer.valueOf(i), Integer.valueOf(i2)});
                } catch (Exception unused) {
                }
                try {
                    AbsCronetDependAdapter.this.onWiFiToCellStateChangedForApp(i, i2);
                } catch (Throwable unused2) {
                }
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public Map<String, String> onCallToAddSecurityFactor(String str, Map<String, String> map) {
        HashMap hashMap = new HashMap();
        for (Map.Entry<String, String> entry : map.entrySet()) {
            ArrayList arrayList = new ArrayList();
            0Tpp.LLJLILLLLZIIL(entry.getValue(), arrayList);
            hashMap.put(entry.getKey(), arrayList);
        }
        return NetworkParams.LJIILLIIL(str, hashMap);
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public void onNetworkQualityRttAndThroughputNotifiedOnIOThread(final int i, final int i2, final int i3) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0uke
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                AbsCronetDependAdapter.this.onNetworkQualityRttAndThroughputNotified(i, i2, i3);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onRTTOrThroughputEstimatesComputedOnIOThread(final int i, final int i2, final int i3) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0uka
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                AbsCronetDependAdapter.this.onRTTOrThroughputEstimatesComputed(i, i2, i3);
                AbsCronetDependAdapter.this.onNQERTTOrThroughputComputed(i, i2, i3);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onPacketLossComputedOnIOThread(final int i, final double d, final double d2, final double d3, final double d4) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0ukV
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                AbsCronetDependAdapter.this.onPacketLossComputed(i, d, d2, d3, d4);
                AbsCronetDependAdapter.this.onNQEPacketLossComputed(i, d, d2, d3, d4);
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onStoreIdcChanged(final String str, final String str2, final String str3, final String str4, final String str5, final String str6) {
        Logger.debug();
        new ThreadPlus() { // from class: X.0uk0
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                if (C19590ufA.LIZ == null) {
                    synchronized (C19590ufA.class) {
                        if (C19590ufA.LIZ == null) {
                            C19590ufA.LIZ = new C19590ufA();
                        }
                    }
                }
                C19590ufA.LIZ.LIZ(str, str2, str3, str4, str5, str6);
                C22530uju LJI = C22530uju.LJI();
                String str7 = str2;
                String str8 = str3;
                String str9 = str4;
                String str10 = str5;
                if (LJI.LJIIJ != null && LJI.LJIIJJI && !TextUtils.isEmpty(str7) && !TextUtils.isEmpty(str8)) {
                    if (LJI.LIZ.equalsIgnoreCase(str7) && LJI.LIZIZ.equalsIgnoreCase(str8) && LJI.LIZLLL.equalsIgnoreCase(str10)) {
                        return;
                    }
                    LJI.LIZLLL = str10;
                    LJI.LIZ = str7;
                    LJI.LIZIZ = str8;
                    LJI.LIZJ = str9;
                    Logger.debug();
                    SharedPreferences.Editor edit = KevaSpAopHook.getSharedPreferences(LJI.LJIIJ, "ttnet_store_region", 0).edit();
                    edit.putString("store_region", LJI.LIZ);
                    edit.putString("store_region_src", LJI.LIZIZ);
                    edit.putString("store_sec_uid", LJI.LIZLLL);
                    edit.apply();
                }
            }
        }.start();
    }

    @Override // com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider
    public final void onTTDnsResolveResult(final String str, final String str2, final int i, final int i2, final int i3, final List<String> list, final String str3) {
        Logger.debug();
        new ThreadPlus(str, str2, i, i2, i3, list, str3) { // from class: X.0uWt
            public AsyncContext _async_context;
            public CallbackRunnable _d_p;
            public final /* synthetic */ String h;
            public final /* synthetic */ int i;
            public final /* synthetic */ int j;
            public final /* synthetic */ int k;
            public final /* synthetic */ List l;

            @Override // com.bytedance.common.utility.concurrent.ThreadPlus, java.lang.Runnable
            public final void run() {
                C15530uWs c15530uWs;
                synchronized (C15530uWs.class) {
                    if (C15530uWs.LIZ == null) {
                        C15530uWs.LIZ = new C15530uWs();
                    }
                    c15530uWs = C15530uWs.LIZ;
                }
                c15530uWs.LIZ(this.i, this.j, this.h, this.k, this.l);
            }

            {
                this.i = i;
                this.j = i2;
                this.k = i3;
                this.l = list;
            }
        }.start();
    }
}
