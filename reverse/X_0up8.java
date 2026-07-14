package X;

import J.N;
import android.content.Context;
import com.ttnet.org.chromium.net.TTAppInfoProvider$AppInfo;
import com.ttnet.org.chromium.net.TTSamplingSettingProvider$TTSlaSamplingSetting;
import com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl;
import com.ttnet.org.chromium.net.impl.CronetLibraryLoader;
import com.ttnet.org.chromium.net.impl.CronetUrlRequestContext;
import java.util.ArrayList;
import java.util.Map;

/* renamed from: X.0up8, reason: invalid class name and case insensitive filesystem */
/* loaded from: E:\douyin-golden-goose-crawler\reverse\partial_dex\classes27.dex */
public final class C25770up8 extends C25820upD {
    public C25760up7 LJJJJI;

    /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
    @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl
    public final C25760up7 LJJJ() {
        return this.LJJJJI;
    }

    @Override // X.C25820upD, com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
    public final /* bridge */ /* synthetic */ AbstractC25550uom LJIJI(AbstractC25740up5 abstractC25740up5) {
        LJJJI(abstractC25740up5);
        return this;
    }

    /* JADX WARN: Type inference failed for: r0v0, types: [X.0up7] */
    @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl
    public final CronetEngineBuilderImpl LJJJI(final AbstractC25740up5 abstractC25740up5) {
        this.LJJJJI = new AbstractC25740up5(abstractC25740up5) { // from class: X.0up7
            public final AbstractC25740up5 LIZ;

            {
                this.LIZ = abstractC25740up5;
            }

            @Override // X.AbstractC25740up5
            public final void loadLibrary(String str) {
                this.LIZ.loadLibrary(str);
            }
        };
        return this;
    }

    public C25770up8(final Context context, final boolean z) {
        new CronetEngineBuilderImpl(context, z) { // from class: X.0upD
            /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LIZJ() {
                this.LJJ = true;
                return this;
            }

            /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJ() {
                this.LJIIJJI = true;
                return this;
            }

            /* JADX DEBUG: Don't trust debug lines info. Lines numbers was adjusted: min line is 0 */
            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJII() {
                this.LJIILIIL = true;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public AbstractC25550uom LJIJI(AbstractC25740up5 abstractC25740up5) {
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIIZ() {
                this.LJJJIL = "android_sub_context";
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIIZI() {
                this.LJJJJ = "TTNET_AN_IO_2";
                return this;
            }

            @Override // X.AbstractC25550uom
            public final CronetUrlRequestContext LIZIZ() {
                if (this.LJ == null) {
                    this.LJ = 0ngy.LIZ(this.LIZ);
                }
                String str = this.LJJJIL;
                if (str != null && !str.isEmpty()) {
                    CronetLibraryLoader.ensureInitialized(this.LIZ, this);
                    if (!N.MkIYfBOW()) {
                        throw new IllegalStateException("Sub engine is not enabled");
                    }
                }
                return new CronetUrlRequestContext(this);
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJFF(boolean z2) {
                this.LJI = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJI(boolean z2) {
                this.LJJI = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIIIZZ(boolean z2) {
                this.LJJIII = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIIZ(long j) {
                this.LJJIFFI = j;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIJ(0Ewz r1) {
                this.LJIILJJIL = r1;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIJJI(C25720up3 c25720up3) {
                this.LJIILL = c25720up3;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIL(int i) {
                this.LJJIIJ = i;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIILIIL(String str) {
                this.LJIJJ = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIILJJIL(Map map) {
                this.LJIJI = map;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIILL(C25600uor c25600uor) {
                this.LJIILLIIL = c25600uor;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIILLIIL(String str) {
                this.LJIIZILJ = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIIZILJ(boolean z2) {
                this.LJJIIJZLJL = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIJ(boolean z2) {
                this.LJJIIZ = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIJJ(long j) {
                this.LJJIZ = j;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIJJLI(ArrayList arrayList) {
                this.LJIJ = arrayList;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJIL(boolean z2) {
                this.LJJIJIIJI = z2;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJI(String str) {
                this.LJJIIZI = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIFFI(String str) {
                this.LJIL = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJII(TTSamplingSettingProvider$TTSlaSamplingSetting tTSamplingSettingProvider$TTSlaSamplingSetting) {
                this.LJJIL = tTSamplingSettingProvider$TTSlaSamplingSetting;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final /* bridge */ /* synthetic */ AbstractC25550uom LJJIIJ(String str) {
                LJJJIL(str);
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIIJZLJL(String str) {
                this.LJIJJLI = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIJ(TTAppInfoProvider$AppInfo tTAppInfoProvider$AppInfo) {
                this.LJJIJ = tTAppInfoProvider$AppInfo;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIJIIJI(long j) {
                this.LJJIJL = j;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final /* bridge */ /* synthetic */ AbstractC25550uom LJJIJIIJIL(InterfaceC26130upi interfaceC26130upi) {
                LJJJJ(interfaceC26130upi);
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIJIL(ArrayList arrayList) {
                this.LJJIJLIJ = arrayList;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIJLIJ(String str) {
                this.LJ = str;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIJL(int i) {
                if (i <= 19 && i >= -20) {
                    this.LJIIL = i;
                    return this;
                }
                throw new IllegalArgumentException("Thread priority invalid");
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final /* bridge */ /* synthetic */ AbstractC25550uom LIZLLL(int i, long j) {
                LJJIZ(i, j);
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJ(boolean z2, boolean z3) {
                this.LJJIJIIJIL = z2;
                this.LJJIJIL = z3;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final AbstractC25550uom LJJIII(int i, boolean z2) {
                this.LJJJ = z2;
                this.LJJJI = i;
                return this;
            }

            @Override // com.ttnet.org.chromium.net.impl.CronetEngineBuilderImpl, X.AbstractC25550uom
            public final /* bridge */ /* synthetic */ AbstractC25550uom LIZ(int i, int i2, String str) {
                LJJIL(i, i2, str);
                return this;
            }
        };
    }
}
