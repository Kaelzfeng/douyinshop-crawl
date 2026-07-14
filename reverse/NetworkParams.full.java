package com.bytedance.frameworks.baselib.network.http;

import X.0FwS;
import X.0FxI;
import X.0H86;
import X.0Tpp;
import X.0U9J;
import X.0U9L;
import X.0U9r;
import X.0UAD;
import X.0ULj;
import X.0Xbq;
import X.0keH;
import X.0lC9;
import X.0lCu;
import X.0lCv;
import X.0lCw;
import X.0lee;
import X.0lkJ;
import X.0lvw;
import X.0oS1;
import X.0ocw;
import X.0ocz;
import X.0ooN;
import X.C22140ujH;
import X.C22540ujv;
import X.C23100ukp;
import X.C23270ul6;
import X.C27010ur8;
import X.InterfaceC22720ukD;
import X.InterfaceC23050ukk;
import X.InterfaceC23150uku;
import X.InterfaceC23250ul4;
import Y.AObjectS98S0100000_29;
import android.app.Activity;
import android.os.Looper;
import android.text.TextUtils;
import android.webkit.CookieManager;
import com.bytedance.common.utility.Logger;
import com.bytedance.common.utility.StringUtils;
import com.bytedance.frameworks.baselib.network.connectionclass.ConnectionClassManager;
import com.bytedance.ies.net.cronet.NetUtils;
import com.bytedance.memoryx.StringBuilderCache;
import com.bytedance.retrofit2.AppActivityResumeSuspendRecorder;
import com.bytedance.retrofit2.RetrofitLayerMetrics;
import com.bytedance.retrofit2.RetrofitMetrics;
import com.bytedance.retrofit2.client.Header;
import com.bytedance.retrofit2.client.Request;
import com.bytedance.ttnet.HttpClient;
import com.bytedance.ttnet.http.HttpRequestInfo;
import com.bytedance.ttnet.http.RequestContext;
import com.huawei.hms.kit.awareness.b.HHF;
import com.ss.android.ugc.aweme.base.TerminalMonitor;
import com.ss.android.ugc.aweme.logger.ColdBootLogger;
import com.ss.aweme.paas.AwemePaasTargetUtilsKt;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import ms.bd.c.f3;
import ms.bd.c.t4;
import ms.bd.c.y4;
import org.json.JSONException;
import org.json.JSONObject;

/* loaded from: E:\douyin-golden-goose-crawler\reverse\partial_dex\classes27.dex */
public class NetworkParams {
    public static 0lCw LIZ;
    public static 0lCu LIZIZ;
    public static volatile boolean LIZJ;
    public static volatile boolean LIZLLL;
    public static volatile boolean LJ;
    public static 0lCv LJFF;
    public static InterfaceC23250ul4 LJI;
    public static InterfaceC23050ukk LJII;
    public static InterfaceC22720ukD LJIIIIZZ;
    public static 0ooN LJIIIZ;
    public static InterfaceC23150uku LJIIJ;
    public static 0lvw LJIIJJI;
    public static 0FxI LJIIL;
    public static 0FwS LJIILLIIL;
    public static volatile 0ULj LJIIZILJ;
    public static volatile 0ocw LJIJ;
    public static boolean LJJIFFI;
    public static boolean LJJII;
    public static final Object LJIILIIL = new Object();
    public static final CountDownLatch LJIILJJIL = new CountDownLatch(1);
    public static String LJIILL = null;
    public static final Map<String, 0Xbq> LJIJI = new ConcurrentHashMap();
    public static final AtomicBoolean LJIJJ = new AtomicBoolean(false);
    public static final AtomicInteger LJIJJLI = new AtomicInteger(0);
    public static int LJIL = 2;
    public static int LJJ = 100;
    public static boolean LJJI = true;

    public static boolean LJ() {
        return LJ;
    }

    public static String LJFF() {
        return LJIILL;
    }

    public static boolean LJI() {
        return LJJII;
    }

    public static void LJIILJJIL() {
        LJIILJJIL.countDown();
        ColdBootLogger.getInstance().end("feed_network_init_cookie_duration", false);
    }

    public static CookieManager LJIIZILJ() {
        synchronized (LJIILIIL) {
            try {
                CountDownLatch countDownLatch = LJIILJJIL;
                countDownLatch.await(HHF.b, TimeUnit.MILLISECONDS);
                countDownLatch.countDown();
            } catch (Exception unused) {
            }
        }
        CookieManager cookieManager = null;
        if (C23100ukp.LIZ.get()) {
            return null;
        }
        try {
            cookieManager = CookieManager.getInstance();
            if (!cookieManager.acceptCookie()) {
                cookieManager.setAcceptCookie(true);
            }
        } catch (Throwable unused2) {
        }
        return cookieManager;
    }

    public static 0ocz LJIILIIL(Map<String, List<String>> map) {
        0ocz r1;
        Activity activity;
        List list;
        if (LJIIZILJ != null) {
            LJIIZILJ.getClass();
            boolean[] zArr = {false};
            HashMap hashMap = new HashMap();
            CountDownLatch countDownLatch = new CountDownLatch(1);
            TreeMap treeMap = (TreeMap) map;
            if (treeMap.containsKey("bdturing-verify")) {
                List list2 = (List) treeMap.get("bdturing-verify");
                if (list2 != null && list2.size() >= 1) {
                    String str = (String) list2.get(0);
                    if (treeMap.containsKey("bdturing-extra") && (list = (List) treeMap.get("bdturing-extra")) != null && list.size() >= 1) {
                        hashMap.put("bdturing-extra", list.get(0));
                    }
                    0U9L r3 = new 0U9L(str);
                    0UAD r0 = 0U9r.LIZ.LIZ;
                    if (r0 != null) {
                        activity = r0.LJFF();
                    } else {
                        activity = null;
                    }
                    ((0U9J) r3).LJIIIIZZ = 0;
                    0U9r.LIZ.LJI(activity, r3, new 0H86(countDownLatch, zArr, hashMap, r3));
                    try {
                        countDownLatch.await();
                    } catch (InterruptedException unused) {
                    }
                } else {
                    r1 = new 0ocz(zArr[0], hashMap);
                    treeMap.remove("bdturing-verify");
                    return r1;
                }
            }
            r1 = new 0ocz(zArr[0], hashMap);
            treeMap.remove("bdturing-verify");
            return r1;
        }
        return new 0ocz(false);
    }

    public static String LIZ(String str, RetrofitMetrics retrofitMetrics) {
        if (LIZ != null) {
            if (retrofitMetrics != null) {
                retrofitMetrics.addCommonParamStart();
            }
            try {
                str = LIZ.LIZIZ(str);
            } finally {
                if (retrofitMetrics != null) {
                    retrofitMetrics.addCommonParamEnd();
                }
            }
        }
        return str;
    }

    public static boolean LIZJ(String str, BaseHttpRequestInfo baseHttpRequestInfo) {
        if (baseHttpRequestInfo != null && !baseHttpRequestInfo.bypassApiReport && !StringUtils.isEmpty(baseHttpRequestInfo.metrics.networklib.networkKernelRawRequestLog) && baseHttpRequestInfo.metrics.retrofit.getRequestDurationMs() >= 0) {
            return !StringUtils.isEmpty(str);
        }
        return false;
    }

    public static void LIZLLL(String str, RetrofitMetrics retrofitMetrics) {
        if (!StringUtils.isEmpty(str) && LJII != null) {
            if (retrofitMetrics != null) {
                retrofitMetrics.filterUrlStart();
            }
            try {
                C22540ujv c22540ujv = (C22540ujv) LJII;
                c22540ujv.getClass();
                if (!StringUtils.isEmpty(str)) {
                    try {
                        if (c22540ujv.a) {
                            c22540ujv.LJIJI();
                        } else {
                            c22540ujv.LJIJ();
                        }
                    } catch (Throwable unused) {
                    }
                }
            } finally {
                if (retrofitMetrics != null) {
                    retrofitMetrics.filterUrlEnd();
                }
            }
        }
    }

    public static void LJIIJJI(String str, BaseHttpRequestInfo baseHttpRequestInfo) {
        if (LIZJ(str, baseHttpRequestInfo) && LIZIZ != null) {
            baseHttpRequestInfo.metrics.logReport();
            LIZIZ.LIZIZ(baseHttpRequestInfo.metrics.retrofit.getRequestDurationMs(), baseHttpRequestInfo.metrics.retrofit.eventTs.ssHttpCallApiStartTime, str, baseHttpRequestInfo.traceCode, baseHttpRequestInfo);
        }
    }

    public static synchronized boolean LIZIZ(String str, 0Xbq r5) {
        synchronized (NetworkParams.class) {
            if (StringUtils.isEmpty(str) || !str.toLowerCase().contains("verify")) {
                return false;
            }
            Iterator it = ((ConcurrentHashMap) LJIJI).keySet().iterator();
            while (it.hasNext()) {
                if (((String) it.next()).equalsIgnoreCase(str)) {
                    return false;
                }
            }
            ((ConcurrentHashMap) LJIJI).put(str, r5);
            return true;
        }
    }

    public static void LJIIL(String str, BaseHttpRequestInfo baseHttpRequestInfo) {
        if (LIZJ(str, baseHttpRequestInfo) && LJFF != null) {
            baseHttpRequestInfo.metrics.logReport();
            JSONObject jSONObject = new JSONObject();
            try {
                baseHttpRequestInfo.metrics.toJson(jSONObject);
            } catch (JSONException unused) {
            }
            0lkJ r1 = LJFF;
            long requestDurationMs = baseHttpRequestInfo.metrics.retrofit.getRequestDurationMs();
            long j = baseHttpRequestInfo.metrics.retrofit.eventTs.ssHttpCallApiStartTime;
            String str2 = baseHttpRequestInfo.traceCode;
            0lkJ r12 = r1;
            r12.getClass();
            HttpRequestInfo httpRequestInfo = (HttpRequestInfo) baseHttpRequestInfo;
            r12.LIZ.getClass();
            try {
                String[] strArr = new String[1];
                if (!0lee.LJII("api_all", str, jSONObject, httpRequestInfo)) {
                    if (str.contains("&config_retry=b")) {
                        jSONObject.put("log_config_retry", 1);
                    }
                    if (TextUtils.isEmpty(strArr[0])) {
                        strArr[0] = httpRequestInfo.remoteIp;
                        RequestContext requestContext = httpRequestInfo.reqContext;
                        if (requestContext != null) {
                            RequestContext requestContext2 = requestContext;
                            RequestContext requestContext3 = requestContext;
                        }
                    }
                    C27010ur8.LJIILL(jSONObject);
                    0keH.LJIJJ = httpRequestInfo.totalTime;
                    C27010ur8.LJIIJJI(httpRequestInfo, jSONObject);
                    jSONObject.put("networkQuality", ConnectionClassManager.getInstance().getCurrentBandwidthQuality().toString());
                    jSONObject.put("downloadSpeed", (int) ConnectionClassManager.getInstance().LIZIZ());
                    jSONObject.put("cronet_plugin_install", C22140ujH.LIZ().LJII.LIZ());
                    jSONObject.put("cronet_plugin_version", C22140ujH.LIZ().LJIIIIZZ.LIZ());
                    if (str.contains("/aweme/v2/feed") && str.contains("rid")) {
                        jSONObject.put("is_feed_compound", "1");
                    }
                    if (!HttpClient.LIZ()) {
                        jSONObject.put("netClientType", "TTOkhttp3Client");
                    } else {
                        jSONObject.put("netClientType", "CronetClient");
                    }
                    if (httpRequestInfo instanceof C23270ul6) {
                        String str3 = ((C23270ul6) httpRequestInfo).mBdTtErrorCode;
                        if (!TextUtils.isEmpty(str3)) {
                            jSONObject.put("errorCode", str3);
                            if (!"0".equals(str3)) {
                                jSONObject.put("logid", ((C23270ul6) httpRequestInfo).mLogid);
                                TerminalMonitor.LIZIZ(requestDurationMs, j, str, strArr[0], str2, 200, jSONObject);
                            }
                        }
                    }
                    C27010ur8.LJIIIZ(null, 0, httpRequestInfo.metrics, jSONObject);
                    TerminalMonitor.LIZJ(requestDurationMs, j, str, strArr[0], str2, 200, jSONObject);
                    C27010ur8.LJIILIIL(requestDurationMs, str, str2, httpRequestInfo, 200, jSONObject);
                }
            } catch (Throwable unused2) {
            }
        }
    }

    /* JADX WARN: Removed duplicated region for block: B:49:0x010a  */
    /*
        Code decompiled incorrectly, please refer to instructions dump.
    */
    public static Map<String, String> LJIILLIIL(String str, Map<String, List<String>> map) {
        Object a;
        String str2;
        y4 y4Var = LJIILLIIL;
        String[] strArr = null;
        if (y4Var == null) {
            return null;
        }
        y4 y4Var2 = y4Var;
        HashMap hashMap = new HashMap();
        if (str != null && map != null) {
            String lowerCase = str.toLowerCase();
            int i = 0;
            if (!lowerCase.contains((String) f3.a(16777217, 0, 0L, "8e890e", new byte[]{33, 115, 95, 93})) && !lowerCase.contains((String) f3.a(16777217, 0, 0L, "5bb309", new byte[]{44, 116, 5, 87, 28})) && !lowerCase.contains((String) f3.a(16777217, 0, 0L, "c884f2", new byte[]{101, 41}))) {
                throw new RuntimeException((String) f3.a(16777217, 0, 0L, "f77f98", new byte[]{126, 33, 4, 31, 19, 60, 113, 86, 100, 51, 55, 61, 80, 6, 22, 96, 109, 2, 114, 38, 100, 122, 83, 1, 21}));
            }
            t4 LIZ2 = t4.LIZ();
            synchronized (LIZ2) {
                if (LIZ2.LIZIZ == null) {
                    int i2 = LIZ2.LIZ;
                    LIZ2.LIZ = i2 + 1;
                    if (i2 >= 30) {
                        LIZ2.LIZ = 0;
                        LIZ2.LIZIZ = new Throwable();
                    }
                }
            }
            ArrayList arrayList = new ArrayList();
            for (Map.Entry<String, List<String>> entry : map.entrySet()) {
                String key = entry.getKey();
                if (entry.getValue() != null && entry.getValue().size() > 0) {
                    str2 = entry.getValue().get(0);
                } else {
                    str2 = null;
                }
                if (key != null && str2 != null) {
                    0Tpp.LLJLILLLLZIIL(key, arrayList);
                    0Tpp.LLJLILLLLZIIL(str2, arrayList);
                }
            }
            if (lowerCase.startsWith((String) f3.a(16777217, 0, 0L, "e9a0e0", new byte[]{124, 47, 6, 84}))) {
                i = 0;
                a = f3.a(50331649, 0, y4Var2.LIZ.LIZ, str, arrayList.toArray(new String[0]));
            } else {
                if (lowerCase.startsWith((String) f3.a(16777217, 0, 0L, "e99cb3", new byte[]{99, 40}))) {
                    0Tpp.LLJLILLLLZIIL(f3.a(16777217, 0, 0L, "73c819", new byte[]{19, 3, 60}), arrayList);
                    0Tpp.LLJLILLLLZIIL(str, arrayList);
                    a = f3.a(100663297, 0, y4Var2.LIZ.LIZ, (String) null, arrayList.toArray(new String[0]));
                }
                if (strArr != null) {
                    hashMap = new HashMap();
                    while (i < strArr.length) {
                        0Tpp.LLLFFI(hashMap, strArr[i], strArr[i + 1]);
                        i += 2;
                    }
                }
            }
            strArr = (String[]) a;
            if (strArr != null) {
            }
        }
        return hashMap;
    }

    public static void LJIIIIZZ(String str, BaseHttpRequestInfo baseHttpRequestInfo, Throwable th) {
        if (LIZJ(str, baseHttpRequestInfo) && LIZIZ != null && th != null) {
            baseHttpRequestInfo.metrics.logReport();
            LIZIZ.LIZ(baseHttpRequestInfo.metrics.retrofit.getRequestDurationMs(), baseHttpRequestInfo.metrics.retrofit.eventTs.ssHttpCallApiStartTime, str, baseHttpRequestInfo.traceCode, baseHttpRequestInfo, th);
        }
    }

    public static void LJIIIZ(String str, BaseHttpRequestInfo baseHttpRequestInfo, Throwable th) {
        if (LIZJ(str, baseHttpRequestInfo) && LJFF != null && th != null) {
            baseHttpRequestInfo.metrics.logReport();
            JSONObject jSONObject = new JSONObject();
            try {
                baseHttpRequestInfo.metrics.toJson(jSONObject);
            } catch (JSONException unused) {
            }
            0lkJ r1 = LJFF;
            long requestDurationMs = baseHttpRequestInfo.metrics.retrofit.getRequestDurationMs();
            long j = baseHttpRequestInfo.metrics.retrofit.eventTs.ssHttpCallApiStartTime;
            String str2 = baseHttpRequestInfo.traceCode;
            0lkJ r12 = r1;
            r12.getClass();
            HttpRequestInfo httpRequestInfo = (HttpRequestInfo) baseHttpRequestInfo;
            r12.LIZ.getClass();
            try {
                String[] strArr = new String[1];
                if (!0lee.LJII("api_error", str, jSONObject, httpRequestInfo)) {
                    if (TextUtils.isEmpty(strArr[0])) {
                        strArr[0] = httpRequestInfo.remoteIp;
                        RequestContext requestContext = httpRequestInfo.reqContext;
                        if (requestContext != null) {
                            RequestContext requestContext2 = requestContext;
                            RequestContext requestContext3 = requestContext;
                        }
                    }
                    0lee.LJIIIIZZ(th, jSONObject);
                    C27010ur8.LJIILL(jSONObject);
                    0keH.LJIJJ = httpRequestInfo.totalTime;
                    C27010ur8.LJIIJJI(httpRequestInfo, jSONObject);
                    jSONObject.put("errorDesc", th.toString());
                    jSONObject.put("networkQuality", ConnectionClassManager.getInstance().getCurrentBandwidthQuality().toString());
                    jSONObject.put("downloadSpeed", (int) ConnectionClassManager.getInstance().LIZIZ());
                    jSONObject.put("cronet_plugin_install", C22140ujH.LIZ().LJII.LIZ());
                    jSONObject.put("cronet_plugin_version", C22140ujH.LIZ().LJIIIIZZ.LIZ());
                    if (!HttpClient.LIZ()) {
                        jSONObject.put("netClientType", "TTOkhttp3Client");
                    } else {
                        jSONObject.put("netClientType", "CronetClient");
                    }
                    if (str.contains("/aweme/v2/feed") && str.contains("rid")) {
                        jSONObject.put("is_feed_compound", "1");
                    }
                    if (httpRequestInfo instanceof C23270ul6) {
                        String str3 = ((C23270ul6) httpRequestInfo).mBdTtErrorCode;
                        String str4 = ((C23270ul6) httpRequestInfo).mLogid;
                        if (!TextUtils.isEmpty(str3)) {
                            jSONObject.put("errorCode", str3);
                        }
                        if (!TextUtils.isEmpty(str4)) {
                            jSONObject.put("logid", str4);
                        }
                    }
                    ArrayList arrayList = new ArrayList();
                    AwemePaasTargetUtilsKt.call(new AObjectS98S0100000_29(arrayList, 120));
                    jSONObject.put("libra_vid", arrayList);
                    int LIZ2 = NetUtils.LIZ(th, strArr);
                    int subStatus = NetUtils.getSubStatus(th);
                    jSONObject.put("substatus", subStatus);
                    C27010ur8.LJIIIZ(th, subStatus, httpRequestInfo.metrics, jSONObject);
                    TerminalMonitor.LIZIZ(requestDurationMs, j, str, strArr[0], str2, LIZ2, jSONObject);
                    TerminalMonitor.LIZJ(requestDurationMs, j, str, strArr[0], str2, LIZ2, jSONObject);
                    C27010ur8.LJIILIIL(requestDurationMs, str, str2, httpRequestInfo, LIZ2, jSONObject);
                }
            } catch (Throwable unused2) {
            }
        }
    }

    public static void LJIIJ(String str, String str2, boolean z, RetrofitMetrics retrofitMetrics) {
        if (!StringUtils.isEmpty(str) && !StringUtils.isEmpty(str2) && LJII != null) {
            if (retrofitMetrics != null) {
                if (!z) {
                    retrofitMetrics.monitorApiHttpBeforeFilterStart();
                } else {
                    retrofitMetrics.monitorApiHttpAfterFilterStart();
                }
            }
            try {
                ((C22540ujv) LJII).LJIILJJIL(str, str2, z);
                if (retrofitMetrics != null) {
                    if (!z) {
                        retrofitMetrics.monitorApiHttpBeforeFilterEnd();
                    } else {
                        retrofitMetrics.monitorApiHttpAfterFilterEnd();
                    }
                }
            } catch (Throwable th) {
                if (retrofitMetrics != null) {
                    if (!z) {
                        retrofitMetrics.monitorApiHttpBeforeFilterEnd();
                    } else {
                        retrofitMetrics.monitorApiHttpAfterFilterEnd();
                        throw th;
                    }
                }
                throw th;
            }
        }
    }

    public static void monitorApiSample(long j, long j2, String str, String str2, BaseHttpRequestInfo baseHttpRequestInfo) {
        if (baseHttpRequestInfo == null) {
            return;
        }
        RetrofitLayerMetrics.EventTimestamp eventTimestamp = baseHttpRequestInfo.metrics.retrofit.eventTs;
        eventTimestamp.ssHttpCallApiStartTime = j2;
        baseHttpRequestInfo.requestStart = j2;
        long j3 = j2 + j;
        eventTimestamp.requestEndTime = j3;
        baseHttpRequestInfo.requestEnd = j3;
        if (eventTimestamp.requestEnd == -1) {
            eventTimestamp.requestEnd = System.nanoTime();
        }
        baseHttpRequestInfo.metrics.setRequestEndAppResumeState(AppActivityResumeSuspendRecorder.GetAppActivityResumeState());
        baseHttpRequestInfo.traceCode = str2;
        baseHttpRequestInfo.useDeprecatedApi = true;
        if (LIZLLL && !baseHttpRequestInfo.reported.compareAndSet(false, true)) {
            return;
        }
        Logger.debug();
        if (LIZJ) {
            LJIIL(str, baseHttpRequestInfo);
        } else {
            LJIIJJI(str, baseHttpRequestInfo);
        }
    }

    public static void LJII(long j, long j2, String str, String str2, 0lC9 r12, Throwable th) {
        if (r12 == null) {
            return;
        }
        RetrofitLayerMetrics.EventTimestamp eventTimestamp = r12.metrics.retrofit.eventTs;
        eventTimestamp.ssHttpCallApiStartTime = j2;
        r12.requestStart = j2;
        long j3 = j2 + j;
        eventTimestamp.requestEndTime = j3;
        r12.requestEnd = j3;
        if (eventTimestamp.requestEnd == -1) {
            eventTimestamp.requestEnd = System.nanoTime();
        }
        r12.metrics.setRequestEndAppResumeState(AppActivityResumeSuspendRecorder.GetAppActivityResumeState());
        r12.traceCode = str2;
        r12.useDeprecatedApi = true;
        if (LIZLLL && !r12.reported.compareAndSet(false, true)) {
            return;
        }
        Logger.debug();
        if (LIZJ) {
            LJIIIZ(str, r12, th);
        } else {
            LJIIIIZZ(str, r12, th);
        }
    }

    /* JADX WARN: Code restructure failed: missing block: B:194:0x0237, code lost:
    
        if (r2 == null) goto L155;
     */
    /* JADX WARN: Code restructure failed: missing block: B:205:0x01dc, code lost:
    
        if (0 != 0) goto L110;
     */
    /* JADX WARN: Removed duplicated region for block: B:147:0x01ad  */
    /* JADX WARN: Removed duplicated region for block: B:179:0x01e9 A[RETURN] */
    /* JADX WARN: Removed duplicated region for block: B:182:0x02b3  */
    /* JADX WARN: Removed duplicated region for block: B:188:0x02c2  */
    /* JADX WARN: Removed duplicated region for block: B:196:0x021f  */
    /* JADX WARN: Removed duplicated region for block: B:200:0x022c  */
    /* JADX WARN: Removed duplicated region for block: B:205:0x01dc  */
    /*
        Code decompiled incorrectly, please refer to instructions dump.
    */
    public static 0ocz LJIILL(Request request, int i, BaseHttpRequestInfo baseHttpRequestInfo, List<Header> list, Map<String, List<String>> map, boolean z, boolean z2) {
        boolean z3;
        Map map2;
        0ocz r2 = new 0ocz(false);
        baseHttpRequestInfo.rotationHostRetry = false;
        if (0Tpp.LLILZ() == Looper.myLooper()) {
            return r2;
        }
        if (i != 200) {
            if (map != null && !map.isEmpty()) {
                for (String str : map.keySet()) {
                    if (StringUtils.isEmpty(str) || !str.toLowerCase().contains("ignore-status-code")) {
                    }
                }
            }
            0ocz r1 = new 0ocz(false);
            if (!z2 && !baseHttpRequestInfo.bdTuringRetry && !baseHttpRequestInfo.accountRetry) {
                LJIJJ.get();
            }
            return r1;
        }
        if (z) {
            0ocz r22 = new 0ocz(false);
            if (map != null && map.containsKey("bdturing-verify")) {
                if (list != null) {
                    for (Header header : list) {
                        if (header != null && "x-tt-bypass-bdturing".equalsIgnoreCase(header.getName()) && "1".equals(header.getValue())) {
                            break;
                        }
                    }
                }
                TreeMap treeMap = new TreeMap(String.CASE_INSENSITIVE_ORDER);
                treeMap.putAll(map);
                AtomicInteger atomicInteger = LJIJJLI;
                if (atomicInteger.incrementAndGet() > LJIL) {
                    atomicInteger.decrementAndGet();
                } else {
                    baseHttpRequestInfo.metrics.bdTuringStart();
                    try {
                        r22 = LJIILIIL(treeMap);
                        atomicInteger.decrementAndGet();
                        baseHttpRequestInfo.metrics.bdTuringEnd();
                        if (!treeMap.containsKey("bdturing-verify")) {
                            baseHttpRequestInfo.executeTuringCallback = true;
                            baseHttpRequestInfo.retryByHeaderFilterKey = "bdturing-verify";
                        }
                        if (r22.LIZ) {
                            baseHttpRequestInfo.bdTuringRetry = true;
                            HashMap hashMap = new HashMap();
                            hashMap.put("x-tt-bdturing-retry", "1");
                            Map map3 = r22.LIZJ;
                            if (map3 != null) {
                                hashMap.putAll(map3);
                            }
                            r22.LIZJ = hashMap;
                        }
                    } catch (Throwable th) {
                        LJIJJLI.decrementAndGet();
                        throw th;
                    }
                }
            }
            0ocz r6 = null;
            if (!baseHttpRequestInfo.executeTuringCallback) {
                r22 = new 0ocz(false);
                if (map != null && !map.isEmpty() && !((ConcurrentHashMap) LJIJI).isEmpty()) {
                    Iterator<String> it = map.keySet().iterator();
                    while (true) {
                        if (!it.hasNext()) {
                            break;
                        }
                        String next = it.next();
                        if (!StringUtils.isEmpty(next) && next.toLowerCase().contains("verify")) {
                            Set<String> keySet = map.keySet();
                            synchronized (NetworkParams.class) {
                                Iterator it2 = ((ConcurrentHashMap) LJIJI).entrySet().iterator();
                                while (true) {
                                    if (!it2.hasNext()) {
                                        break;
                                    }
                                    Map.Entry entry = (Map.Entry) it2.next();
                                    for (String str2 : keySet) {
                                        if (!StringUtils.isEmpty(str2) && str2.equalsIgnoreCase((String) entry.getKey())) {
                                            if (list != null) {
                                                StringBuilder sb = StringBuilderCache.get();
                                                sb.append("x-tt-bypass-retry-by-");
                                                sb.append((String) entry.getKey());
                                                String release = StringBuilderCache.release(sb);
                                                for (Header header2 : list) {
                                                    if (header2 != null && release.equalsIgnoreCase(header2.getName()) && "1".equals(header2.getValue())) {
                                                        break;
                                                    }
                                                }
                                            }
                                            0oS1 r8 = (0Xbq) entry.getValue();
                                            if (r8 != null) {
                                                AtomicInteger atomicInteger2 = LJIJJLI;
                                                if (atomicInteger2.incrementAndGet() > LJIL) {
                                                    atomicInteger2.decrementAndGet();
                                                } else {
                                                    baseHttpRequestInfo.metrics.bdTuringStart();
                                                    try {
                                                        if (r8 instanceof 0oS1) {
                                                            request.getUrl();
                                                            r22 = r8.LIZIZ(map);
                                                        } else {
                                                            r22 = r8.LIZ(map);
                                                        }
                                                        atomicInteger2.decrementAndGet();
                                                        baseHttpRequestInfo.metrics.bdTuringEnd();
                                                        baseHttpRequestInfo.retryByHeaderFilterKey = (String) entry.getKey();
                                                        if (r22 != null) {
                                                            if (r22.LIZ) {
                                                                baseHttpRequestInfo.bdTuringRetry = true;
                                                                Map map4 = r22.LIZJ;
                                                                if (map4 == null) {
                                                                    map4 = new HashMap();
                                                                }
                                                                StringBuilder sb2 = StringBuilderCache.get();
                                                                sb2.append("x-tt-retry-by-");
                                                                sb2.append((String) entry.getKey());
                                                                map4.put(StringBuilderCache.release(sb2), "1");
                                                                r22.LIZJ = map4;
                                                            }
                                                        }
                                                    } catch (Throwable th2) {
                                                        LJIJJLI.decrementAndGet();
                                                        baseHttpRequestInfo.metrics.bdTuringEnd();
                                                        throw th2;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (r22.LIZ) {
                z3 = true;
                String url = request.getUrl();
                if (LJIJ != null) {
                    if (list != null) {
                        for (Header header3 : list) {
                            if (header3 == null || !"x-tt-bypass-retry-for-account".equalsIgnoreCase(header3.getName()) || !"1".equals(header3.getValue())) {
                            }
                        }
                    }
                    baseHttpRequestInfo.metrics.accountRetryStart();
                    try {
                        r6 = LJIJ.LIZ(url, list, map);
                    } catch (Throwable unused) {
                    }
                    baseHttpRequestInfo.metrics.accountRetryEnd();
                    if (!z3) {
                        if (r6 != null) {
                            if (r6.LIZ) {
                                baseHttpRequestInfo.retryByHeaderFilterKey = "x-tt-retry-for-account";
                                HashMap hashMap2 = new HashMap();
                                hashMap2.put("x-tt-retry-for-account", "1");
                                Map map5 = r6.LIZJ;
                                if (map5 != null) {
                                    hashMap2.putAll(map5);
                                }
                                r6.LIZJ = hashMap2;
                                baseHttpRequestInfo.accountRetry = true;
                            }
                            if (r22 != null) {
                                r6.LIZIZ = r22.LIZIZ;
                            }
                            r22 = r6;
                            if (r22.LIZ) {
                                return r22;
                            }
                            0ocz r12 = new 0ocz(false);
                            if (!z2 && !baseHttpRequestInfo.bdTuringRetry && !baseHttpRequestInfo.accountRetry) {
                                LJIJJ.get();
                            }
                            if (r22 != null) {
                                r12.LIZIZ = r22.LIZIZ;
                            }
                            return r12;
                        }
                    }
                    if (r6 != null && r6.LIZJ != null) {
                        HashMap hashMap3 = new HashMap();
                        map2 = r22.LIZJ;
                        if (map2 != null) {
                            hashMap3.putAll(map2);
                        }
                        hashMap3.putAll(r6.LIZJ);
                        r22.LIZJ = hashMap3;
                        if (r22.LIZ) {
                        }
                        0ocz r122 = new 0ocz(false);
                        if (!z2) {
                            LJIJJ.get();
                        }
                        if (r22 != null) {
                        }
                        return r122;
                    }
                }
                if (!z3) {
                }
                if (r6 != null) {
                    HashMap hashMap32 = new HashMap();
                    map2 = r22.LIZJ;
                    if (map2 != null) {
                    }
                    hashMap32.putAll(r6.LIZJ);
                    r22.LIZJ = hashMap32;
                    if (r22.LIZ) {
                    }
                    0ocz r1222 = new 0ocz(false);
                    if (!z2) {
                    }
                    if (r22 != null) {
                    }
                    return r1222;
                }
            }
            z3 = false;
            String url2 = request.getUrl();
            if (LJIJ != null) {
            }
            if (!z3) {
            }
            if (r6 != null) {
            }
        }
        0ocz r13 = new 0ocz(false);
        if (!z2) {
            LJIJJ.get();
        }
        return r13;
    }
}
