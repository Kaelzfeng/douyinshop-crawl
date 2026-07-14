package X;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;
import com.bytedance.aweme.coffee.json.JSONTokenerGetter;
import com.bytedance.common.utility.Logger;
import com.bytedance.common.utility.StringUtils;
import com.bytedance.frameworks.baselib.network.http.NetworkParams;
import com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider;
import com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient;
import com.bytedance.frameworks.baselib.network.http.cronet.ICronetInitListener;
import com.huawei.hms.kit.awareness.b.b;
import com.ss.android.ugc.bytex.async.stack.broken_chain.CallbackRunnable;
import com.ss.android.ugc.bytex.async.stack.transmitter.AsyncContext;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.chromium.CronetClient;
import org.json.JSONObject;

/* renamed from: X.0ujw, reason: invalid class name and case insensitive filesystem */
/* loaded from: E:\douyin-golden-goose-crawler\reverse\partial_dex\classes27.dex */
public final class C22550ujw extends AbstractC21970uj0 {
    public static volatile int LIZ = 0;
    public static Context LIZIZ = null;
    public static volatile ICronetClient LIZJ = null;
    public static volatile ICronetClient LIZLLL = null;
    public static volatile C22550ujw LJ = null;
    public static volatile boolean LJFF = true;
    public static volatile String LJI;
    public static volatile String LJII;
    public static final ConcurrentHashMap<String, Integer> LJIIIIZZ = new ConcurrentHashMap<>();
    public static final Map<String, Integer> LJIIIZ = new ConcurrentHashMap();
    public static volatile ICronetAppProvider LJIIJ;
    public static volatile ICronetInitListener LJIIJJI;
    public static InterfaceC23160ukv LJIIL;

    public static void LIZIZ() {
        if (LIZJ != null) {
        } else {
            throw new UnsupportedOperationException("CronetEngine has not been initialized.");
        }
    }

    public static void LJI() {
        if (LIZJ == null) {
            synchronized (C22550ujw.class) {
                if (LIZJ == null) {
                    LIZJ = LIZJ();
                }
            }
        }
    }

    public static ICronetClient LIZJ() {
        if (NetworkParams.LJJII) {
            return new CronetClient();
        }
        String str = b.d;
        if (StringUtils.isEmpty(b.d)) {
            str = "org.chromium.CronetClient";
        }
        try {
            Object newInstance = 0Tpp.h0(str).newInstance();
            if (newInstance instanceof ICronetClient) {
                return (ICronetClient) newInstance;
            }
            return null;
        } catch (Throwable unused) {
            return null;
        }
    }

    public C22550ujw(Context context) {
        LIZIZ = context.getApplicationContext();
    }

    public static C22550ujw LJ(Context context) {
        if (LJ == null) {
            synchronized (C22550ujw.class) {
                if (LJ == null) {
                    LJ = new C22550ujw(context);
                    LJI();
                }
            }
        }
        return LJ;
    }

    public static void LJIIIIZZ(JSONObject jSONObject) {
        int optInt;
        ((ConcurrentHashMap) LJIIIZ).clear();
        Iterator<String> keys = jSONObject.keys();
        while (keys.hasNext()) {
            String next = keys.next();
            if (!TextUtils.isEmpty(next) && (optInt = jSONObject.optInt(next)) > 0 && optInt <= 20971520) {
                ((ConcurrentHashMap) LJIIIZ).put(next, Integer.valueOf(optInt));
            }
        }
    }

    public static void LJIIIZ(JSONObject jSONObject) {
        LJIIIIZZ.clear();
        Iterator<String> keys = jSONObject.keys();
        while (keys.hasNext()) {
            String next = keys.next();
            int optInt = jSONObject.optInt(next);
            if (!TextUtils.isEmpty(next) && optInt >= 16384 && optInt <= 10485760) {
                LJIIIIZZ.put(next, Integer.valueOf(optInt));
            }
        }
    }

    /* JADX WARN: Removed duplicated region for block: B:152:0x01dd  */
    /* JADX WARN: Removed duplicated region for block: B:18:0x0045  */
    /* JADX WARN: Removed duplicated region for block: B:41:0x0075  */
    /*
        Code decompiled incorrectly, please refer to instructions dump.
        To view partially-correct add '--show-bad-code' argument
    */
    public final com.bytedance.retrofit2.client.SsCall newSsCall(com.bytedance.retrofit2.client.Request r18) {
        /*
            r17 = this;
            r2 = r18
            java.lang.Object r0 = r2.getExtraInfo()
            boolean r0 = r0 instanceof com.bytedance.frameworks.baselib.network.http.BaseRequestContext
            java.util.concurrent.atomic.AtomicBoolean r0 = X.C22110ujE.LIZ
            boolean r0 = r0.get()
            r1 = 0
            if (r0 == 0) goto L2e
            java.util.List<java.lang.String> r3 = X.C22110ujE.LJ
            boolean r0 = r3.isEmpty()
            if (r0 != 0) goto L2e
            java.net.URI r0 = r2.getUri()     // Catch: java.lang.Throwable -> L2e
            if (r0 == 0) goto L2e
            java.net.URI r0 = r2.getUri()     // Catch: java.lang.Throwable -> L2e
            java.lang.String r0 = r0.getHost()     // Catch: java.lang.Throwable -> L2e
            if (r0 == 0) goto L2e
            boolean r5 = r3.contains(r0)     // Catch: java.lang.Throwable -> L2e
            goto L2f
        L2e:
            r5 = 0
        L2f:
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = X.C22550ujw.LIZJ
            r3 = 1
            if (r0 == 0) goto L51
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = X.C22550ujw.LIZJ
            boolean r0 = r0.isReadyForSubEngine()
            if (r0 == 0) goto L51
            r4 = 1
        L3d:
            java.util.concurrent.atomic.AtomicBoolean r0 = X.C22110ujE.LIZIZ
            boolean r0 = r0.get()
            if (r5 == 0) goto L6e
            if (r4 == 0) goto L67
            if (r0 == 0) goto L67
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = X.C22550ujw.LIZLLL
            if (r0 != 0) goto L67
            java.lang.Class<X.0ujw> r4 = X.C22550ujw.class
            monitor-enter(r4)
            goto L53
        L51:
            r4 = 0
            goto L3d
        L53:
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = X.C22550ujw.LIZLLL     // Catch: java.lang.Throwable -> L64
            if (r0 != 0) goto L62
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = LIZJ()     // Catch: java.lang.Throwable -> L64
            if (r0 == 0) goto L62
            r0.markAsSubEngine()     // Catch: java.lang.Throwable -> L64
            X.C22550ujw.LIZLLL = r0     // Catch: java.lang.Throwable -> L64
        L62:
            monitor-exit(r4)     // Catch: java.lang.Throwable -> L64
            goto L67
        L64:
            r0 = move-exception
            monitor-exit(r4)     // Catch: java.lang.Throwable -> L64
            throw r0
        L67:
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r0 = X.C22550ujw.LIZLLL
            if (r0 == 0) goto L6e
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r11 = X.C22550ujw.LIZLLL
            goto L73
        L6e:
            LJI()
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetClient r11 = X.C22550ujw.LIZJ
        L73:
            if (r11 == 0) goto L1dd
            android.content.Context r12 = X.C22550ujw.LIZIZ
            java.lang.String r13 = com.bytedance.frameworks.baselib.network.http.NetworkParams.LJIILL
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetAppProvider r14 = X.C22550ujw.LJIIJ
            com.bytedance.frameworks.baselib.network.http.cronet.ICronetInitListener r15 = X.C22550ujw.LJIIJJI
            java.lang.String r16 = r2.getPath()
            r11.lazyInitCronetEngine(r12, r13, r14, r15, r16)
            com.bytedance.retrofit2.mime.TypedOutput r4 = r2.getBody()
            boolean r0 = r4 instanceof com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput
            if (r0 == 0) goto L9c
            com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput r4 = (com.bytedance.retrofit2.mime.FormUrlEncodedTypedOutput) r4
            r4.useFormBodyModifyHookAndConstructStream(r2)
            com.bytedance.retrofit2.client.Request$Builder r0 = r2.newBuilder()
            r0.post(r4)
            com.bytedance.retrofit2.client.Request r2 = r0.build()
        L9c:
            com.bytedance.frameworks.baselib.network.queryfilter.QueryFilterEngine r0 = com.bytedance.frameworks.baselib.network.queryfilter.QueryFilterEngine.inst()
            com.bytedance.retrofit2.client.Request r4 = r0.LIZJ(r2)
            android.content.Context r0 = X.C22550ujw.LIZIZ
            X.0J7i.LIZ(r0, r4)
            if (r4 == 0) goto Lac
            r2 = r4
        Lac:
            X.0ujz r0 = X.C22580ujz.LIZJ()
            int r0 = r0.LIZ
            if (r0 <= 0) goto L1d7
            java.lang.String r4 = r2.getUrl()
            java.lang.String r0 = "no_retry=1"
            boolean r0 = r4.contains(r0)
            if (r0 != 0) goto L1d7
            X.0ujz r9 = X.C22580ujz.LIZJ()
            java.util.List<X.0uk1> r0 = r9.LIZIZ
            java.util.concurrent.CopyOnWriteArrayList r0 = (java.util.concurrent.CopyOnWriteArrayList) r0
            java.util.Iterator r10 = r0.iterator()
        Lcc:
            boolean r0 = r10.hasNext()
            if (r0 == 0) goto Lf2
            java.lang.Object r8 = r10.next()
            X.0uk1 r8 = (X.C22600uk1) r8
            boolean r0 = r8.LJIIJJI
            if (r0 == 0) goto Lcc
            long r6 = android.os.SystemClock.uptimeMillis()
            long r4 = r8.LJIIJ
            long r6 = r6 - r4
            int r0 = r8.LJI
            int r0 = r0 * 1000
            long r4 = (long) r0
            int r0 = (r6 > r4 ? 1 : (r6 == r4 ? 0 : -1))
            if (r0 <= 0) goto Lee
            r8.LJIIJJI = r1
        Lee:
            com.bytedance.common.utility.Logger.debug()
            goto Lcc
        Lf2:
            java.util.List<X.0uk1> r0 = r9.LIZIZ
            java.util.concurrent.CopyOnWriteArrayList r0 = (java.util.concurrent.CopyOnWriteArrayList) r0
            java.util.Iterator r6 = r0.iterator()
        Lfa:
            boolean r0 = r6.hasNext()
            if (r0 == 0) goto L1d7
            java.lang.Object r4 = r6.next()
            X.0uk1 r4 = (X.C22600uk1) r4
            int r0 = r4.LJI
            if (r0 <= 0) goto L10f
            boolean r0 = r4.LJIIJJI
            if (r0 == 0) goto L10f
            goto Lfa
        L10f:
            java.lang.String r0 = r2.getUrl()
            boolean r0 = android.text.TextUtils.isEmpty(r0)
            if (r0 != 0) goto Lfa
            java.util.List<java.lang.String> r0 = r4.LIZ
            java.util.Iterator r5 = r0.iterator()
        L11f:
            boolean r0 = r5.hasNext()
            if (r0 == 0) goto L1d2
            java.lang.Object r1 = r5.next()
            java.lang.String r1 = (java.lang.String) r1
            java.lang.String r0 = r2.getHost()
            boolean r0 = com.bytedance.frameworks.baselib.network.http.util.UrlUtils.LIZIZ(r0, r1)
            if (r0 == 0) goto L11f
            java.lang.String r5 = r2.getPath()
            boolean r0 = android.text.TextUtils.isEmpty(r5)
            if (r0 != 0) goto Lfa
            java.util.List<java.lang.String> r0 = r4.LIZJ
            if (r0 == 0) goto L17e
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            boolean r0 = r0.isEmpty()
            if (r0 != 0) goto L17e
            java.util.List<java.lang.String> r0 = r4.LIZJ
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            java.util.Iterator r1 = r0.iterator()
        L153:
            boolean r0 = r1.hasNext()
            if (r0 == 0) goto L17e
            java.lang.Object r0 = r1.next()
            boolean r0 = r5.equals(r0)
            if (r0 == 0) goto L153
        L163:
            java.util.List<java.lang.String> r0 = r4.LIZIZ
            if (r0 == 0) goto L1d7
            int r1 = r0.size()
            r0 = 2
            if (r1 < r0) goto L1d7
            com.bytedance.retrofit2.RetrofitMetrics r0 = r2.getMetrics()
            com.bytedance.retrofit2.NetworkLibLayerMetrics r0 = r0.networklib
            com.bytedance.retrofit2.NetworkLibLayerMetrics$Misc r0 = r0.misc
            r0.isConcurrentRequest = r3
            X.0ul9 r0 = new X.0ul9
            r0.<init>(r2, r4, r11)
            return r0
        L17e:
            java.util.List<java.lang.String> r0 = r4.LIZLLL
            if (r0 == 0) goto L1a5
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            boolean r0 = r0.isEmpty()
            if (r0 != 0) goto L1a5
            java.util.List<java.lang.String> r0 = r4.LIZLLL
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            java.util.Iterator r1 = r0.iterator()
        L192:
            boolean r0 = r1.hasNext()
            if (r0 == 0) goto L1a5
            java.lang.Object r0 = r1.next()
            java.lang.String r0 = (java.lang.String) r0
            boolean r0 = r5.startsWith(r0)
            if (r0 == 0) goto L192
            goto L163
        L1a5:
            java.util.List<java.util.regex.Pattern> r0 = r4.LJ
            if (r0 == 0) goto Lfa
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            boolean r0 = r0.isEmpty()
            if (r0 != 0) goto Lfa
            java.util.List<java.util.regex.Pattern> r0 = r4.LJ
            java.util.ArrayList r0 = (java.util.ArrayList) r0
            java.util.Iterator r1 = r0.iterator()
        L1b9:
            boolean r0 = r1.hasNext()
            if (r0 == 0) goto Lfa
            java.lang.Object r0 = r1.next()
            java.util.regex.Pattern r0 = (java.util.regex.Pattern) r0
            if (r0 == 0) goto L1b9
            java.util.regex.Matcher r0 = r0.matcher(r5)     // Catch: java.lang.IllegalArgumentException -> L1b9
            boolean r0 = r0.matches()     // Catch: java.lang.IllegalArgumentException -> L1b9
            if (r0 == 0) goto L1b9
            goto L163
        L1d2:
            com.bytedance.common.utility.Logger.debug()
            goto Lfa
        L1d7:
            X.0ulG r0 = new X.0ulG
            r0.<init>(r2, r11)
            return r0
        L1dd:
            java.io.IOException r1 = new java.io.IOException
            java.lang.String r0 = "createCronetClient failed"
            r1.<init>(r0)
            throw r1
        */
        throw new UnsupportedOperationException("Method not decompiled: X.C22550ujw.newSsCall(com.bytedance.retrofit2.client.Request):com.bytedance.retrofit2.client.SsCall");
    }

    public static int LIZLLL(int i, String str) {
        if (i < 16384 || i > 10485760) {
            i = 0;
        }
        if (TextUtils.isEmpty(str)) {
            return i;
        }
        ConcurrentHashMap<String, Integer> concurrentHashMap = LJIIIIZZ;
        if (concurrentHashMap.containsKey(str)) {
            Integer num = concurrentHashMap.get(str);
            if (num != null) {
                i = num.intValue();
            }
            return 0;
        }
        if (i < 16384 || i > 10485760) {
            return 0;
        }
        return i;
    }

    public static void LJFF(final ICronetAppProvider iCronetAppProvider, final C15570uWw c15570uWw) {
        int max;
        LJI();
        if (LIZJ != null) {
            LIZJ.tryCreateCronetEngine(LIZIZ, NetworkParams.LJIILL, iCronetAppProvider, c15570uWw);
            if (C22110ujE.LIZ.get() && C22110ujE.LIZJ.get() && (max = Math.max(0, C22110ujE.LIZLLL)) > 0) {
                final long j = max;
                C21250uhq.LIZ(0rVn.NETWORK).LIZIZ(new AbstractRunnableC21270uhs(j) { // from class: X.0uk2
                    public AsyncContext _async_context;
                    public CallbackRunnable _d_p;

                    @Override // java.lang.Runnable
                    public final void run() {
                        Logger.debug();
                        if (C22110ujE.LIZ.get() && C22110ujE.LIZJ.get() && C22550ujw.LIZJ != null && C22550ujw.LIZJ.isReadyForSubEngine()) {
                            try {
                                if (C22550ujw.LIZLLL == null) {
                                    C22550ujw.LIZLLL = C22550ujw.LIZJ();
                                    if (C22550ujw.LIZLLL != null) {
                                        C22550ujw.LIZLLL.markAsSubEngine();
                                    }
                                }
                                if (C22550ujw.LIZLLL != null) {
                                    C22550ujw.LIZLLL.getInitMetrics().LJI(EnumC22680uk9.PRE_INIT, null);
                                    C22550ujw.LIZLLL.tryCreateCronetEngine(C22550ujw.LIZIZ, NetworkParams.LJIILL, iCronetAppProvider, c15570uWw);
                                }
                            } catch (Throwable unused) {
                            }
                        }
                    }
                });
            }
        }
    }

    public static void LJII(JSONObject jSONObject, SharedPreferences sharedPreferences) {
        if (jSONObject != null) {
            LIZ = jSONObject.optInt("cronet_inputstream_buff_size", 0);
            try {
                JSONObject optJSONObject = jSONObject.optJSONObject("post_body_buffer_size");
                if (optJSONObject != null) {
                    LJIIIZ(optJSONObject);
                    LJI = 0Tpp.LLILZIL(optJSONObject);
                } else {
                    LJIIIIZZ.clear();
                    LJI = b.d;
                }
                JSONObject optJSONObject2 = jSONObject.optJSONObject("path_cronet_inputstream_buff_size");
                if (optJSONObject2 != null) {
                    String LLILZIL = 0Tpp.LLILZIL(optJSONObject2);
                    if (LJII != null && LLILZIL.equals(LJII)) {
                        return;
                    }
                    LJIIIIZZ(optJSONObject2);
                    LJII = LLILZIL;
                } else {
                    ((ConcurrentHashMap) LJIIIZ).clear();
                    LJII = b.d;
                }
            } catch (Throwable unused) {
            }
        }
        if (sharedPreferences != null) {
            LIZ = sharedPreferences.getInt("cronet_inputstream_buff_size", 0);
            String string = sharedPreferences.getString("post_body_buffer_size", b.d);
            if (!TextUtils.isEmpty(string)) {
                try {
                    LJIIIZ(new JSONObject(JSONTokenerGetter.get(string)));
                } catch (Throwable unused2) {
                }
            }
            String string2 = sharedPreferences.getString("path_cronet_inputstream_buff_size", b.d);
            if (!TextUtils.isEmpty(string2)) {
                try {
                    LJIIIIZZ(new JSONObject(JSONTokenerGetter.get(string2)));
                } catch (Throwable unused3) {
                }
            }
        }
    }

    public static void LIZ(String[] strArr, byte[] bArr, byte[] bArr2, long j, long j2, boolean z) {
        if (LIZJ == null) {
            return;
        }
        if (!z && !0Exj.LIZLLL(LIZIZ)) {
            return;
        }
        LIZJ.addClientOpaqueData(strArr, bArr, bArr2, j, j2);
    }
}
