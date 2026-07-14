package com.ss.android.ugc.aweme.net.preload;

import X.C39430hro;
import Y.AObjectS63S0000000_23;
import Y.ARunnableS122S0000000_16;
import android.content.Context;
import com.bytedance.librarian.Librarian;
import com.ss.android.ugc.aweme.lego.LegoComponent;
import com.ss.android.ugc.aweme.lego.LegoTask;
import com.ss.android.ugc.aweme.lego.ProcessType;
import com.ss.android.ugc.aweme.lego.TriggerType;
import com.ss.android.ugc.aweme.lego.WorkType;
import com.ss.android.ugc.aweme.thread.ThreadPoolHelper;
import com.ss.android.ugc.nimbleworker.Condition;
import com.ss.android.ugc.nimbleworker.ResourceType;
import com.ss.android.ugc.nimbleworker.ScheduleType;
import com.ss.android.ugc.nimbleworker.Worker;
import com.ss.aweme.paas.AwemePaasTargetUtilsKt;

/* loaded from: E:\douyin-golden-goose-crawler\reverse\target_dex\classes17.dex */
public class TTnetSoPreloadTask implements LegoTask {
    public static volatile boolean a;
    public static volatile boolean b;

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ Worker.Result doWork() {
        return LegoTask.CC.$default$doWork(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask, com.ss.android.ugc.aweme.lego.LegoComponent
    public final /* synthetic */ Condition getCondition() {
        return LegoTask.CC.$default$getCondition(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ int getPriority() {
        return LegoTask.CC.$default$getPriority(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ ResourceType getResourceType() {
        return LegoTask.CC.$default$getResourceType(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ ScheduleType getScheduleType() {
        return LegoTask.CC.$default$getScheduleType(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ int getState() {
        return LegoTask.CC.$default$getState(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoComponent
    public final /* synthetic */ Worker getWorker() {
        LegoComponent.-CC.$default$getWorker(this);
        return this;
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoComponent
    public final /* synthetic */ String key() {
        return LegoComponent.-CC.$default$key(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ ProcessType process() {
        ProcessType processType;
        processType = ProcessType.MAIN;
        return processType;
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final /* synthetic */ boolean serialExecute() {
        return LegoTask.CC.$default$serialExecute(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoComponent
    public final int targetProcess() {
        return 1;
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoComponent
    public final /* synthetic */ TriggerType triggerType() {
        return LegoComponent.-CC.$default$triggerType(this);
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask
    public final WorkType type() {
        return (WorkType) AwemePaasTargetUtilsKt.call(new AObjectS63S0000000_23(26));
    }

    public static void LIZ(String str) {
        if (!a) {
            synchronized (TTnetSoPreloadTask.class) {
                if (!a) {
                    System.currentTimeMillis();
                    try {
                        Librarian.loadLibrary(str);
                        a = true;
                    } catch (Throwable unused) {
                    }
                }
            }
        }
    }

    @Override // com.ss.android.ugc.aweme.lego.LegoTask, com.ss.android.ugc.aweme.lego.LegoComponent
    public final void run(Context context) {
        if (C39430hro.LIZ()) {
            ThreadPoolHelper.getIOExecutor().execute(new ARunnableS122S0000000_16(6));
        }
    }
}
