import sys
from pathlib import Path
from androguard.core.dex import DEX
for f in sys.argv[1:]:
 d=DEX(Path(f).read_bytes())
 for c in d.get_classes():
  for m in c.get_methods():
   code=m.get_code()
   if not code:continue
   ins=list(code.get_bc().get_instructions())
   for ix,x in enumerate(ins):
    if 'LY/ARunnableS122S0000000_16;-><init>(I)V' in x.get_output():
     prev=ins[ix-1].get_output() if ix else ''
     if any(k in prev for k in ('6','0x6')):
      print(Path(f).name,c.get_name(),m.get_name(),m.get_descriptor(),ix,prev,x.get_output())
