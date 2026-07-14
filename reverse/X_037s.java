package X;

import com.bytedance.dataplatform.ExperimentManager;
import com.bytedance.dataplatform.client.ClientDataSource;
import com.bytedance.dataplatform.client.ClientGroup;
import com.bytedance.ies.ugc.appcontext.AppContextManager;
import com.ss.aweme.paas.AwemePaasTargetUtilsKt;
import com.ss.aweme.paas.CallResult;
import com.ss.aweme.paas.CallScope;
import java.security.SecureRandom;
import java.util.List;
import kotlin.Lazy;
import kotlin.LazyKt__LazyJVMKt;
import kotlin.Unit;
import kotlin.collections.CollectionsKt;
import kotlin.jvm.JvmStatic;
import kotlin.jvm.functions.Function0;
import kotlin.ranges.IntRange;

/* renamed from: X.037s, reason: invalid class name and case insensitive filesystem */
/* loaded from: E:\douyin-golden-goose-crawler\reverse\target_dex\classes.dex */
public final class C7844037s {
    public static final List<Integer> LIZ = CollectionsKt.toList(new IntRange(8261308, 8261311));
    public static final Lazy LIZIZ = LazyKt__LazyJVMKt.lazy((C7826037a) new Function0<Integer>() { // from class: X.037a
        public final Object invoke() {
            int i = 0Tpp.LLIIZ(1, "ab_repo_cold_boot").getInt("report_new_user_no_did_feed_server_opt_again", -1);
            if (i > -1) {
                return Integer.valueOf(i);
            }
            int nextInt = new SecureRandom().nextInt(4);
            0Tpp.LLIIZ(1, "ab_repo_cold_boot").storeInt("report_new_user_no_did_feed_server_opt_again", nextInt);
            return Integer.valueOf(nextInt);
        }
    });

    @JvmStatic
    public static final boolean LIZIZ() {
        0ayw.LIZ(AppContextManager.INSTANCE.getApplicationContext());
        boolean z = false;
        if (!0ayw.LIZ) {
            return false;
        }
        CallScope callScope = new CallScope();
        if (2 == AwemePaasTargetUtilsKt.getCurrentAppTargetCompat()) {
            CallResult callResult = callScope.getCallResult();
            if (((Number) LIZIZ.getValue()).intValue() > 1) {
                z = true;
            }
            callResult.setValue(Boolean.valueOf(z));
            callScope.setHasMatched(true);
        }
        if (!callScope.getHasMatched()) {
            callScope.getCallResult().setValue(Boolean.TRUE);
        }
        return ((Boolean) callScope.getCallResult().getValue()).booleanValue();
    }

    @JvmStatic
    public static final void LIZ() {
        Integer num;
        CallScope callScope = new CallScope();
        if (2 == AwemePaasTargetUtilsKt.getCurrentAppTargetCompat()) {
            CallResult callResult = callScope.getCallResult();
            int i = 0Tpp.LLIIZ(1, "ab_repo_cold_boot").getInt("report_new_user_no_did_feed_server_opt_again", -1);
            if (i > -1 && (num = (Integer) CollectionsKt.getOrNull(LIZ, i)) != null) {
                ExperimentManager.getExperimentValue("NoDidFeedServerOptAB_vid", Integer.TYPE, 0, false, true, new ClientDataSource("com.ss.android.ugc.aweme.experiment.NoDidFeedServerOptAB", 0.0d, "NoDidFeedServerOptAB", new String[]{"NoDidFeedServerOptAB_vid"}, new ClientGroup[]{new ClientGroup(String.valueOf(num.intValue()), 1.0d, 0)}));
            }
            callResult.setValue(Unit.INSTANCE);
            callScope.setHasMatched(true);
        }
        if (!callScope.getHasMatched()) {
            callScope.getCallResult().setValue(Unit.INSTANCE);
        }
        callScope.getCallResult().getValue();
    }
}
