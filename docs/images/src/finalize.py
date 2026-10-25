# 把 mk.js 渲染出的 out/*.png 压成 128 色，放进 docs/images（英文版放 docs/images/en）
# 用法：python finalize.py [en] [名字…]   不给名字就导出全部；use / charts：只导出 use-* 对比图 / chart-* 图表
# 一键重做两种语言：node mk.js all && node mk.js --en all && python finalize.py && python finalize.py en
# 界面截图（ui-*.png）不在这里生成，是在 VS Code 里截的
import os, sys
from PIL import Image
args = sys.argv[1:]
EN = 'en' in args
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, 'out', 'en') if EN else os.path.join(here, 'out')
dst = os.path.join(here, '..', 'en') if EN else os.path.join(here, '..')
drawn = ['overview', 'pain', 'idea', 'scope', 'recorder', 'chart-recorder', 'chart-confusion', 'chart-audit', 'chart-migrate', 'chart-chapter',
         'chart-replay', 'chart-reorg', 'chart-effect',
         'use-1-change-tracking', 'use-2-one-place', 'use-3-rewrite-not-append', 'use-4-survive-compaction',
         'use-5-load-on-demand', 'use-6-override', 'use-7-live-status', 'use-8-click-not-markdown', 'use-9-check']
names = [a for a in args if a in drawn]
if 'use' in args: names = [d for d in drawn if d.startswith('use-')]
elif 'charts' in args: names = [d for d in drawn if d.startswith('chart-')]
elif not names: names = drawn
for n in names:
    im = Image.open(os.path.join(src, n + '.png')).convert('RGB')
    q = im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = os.path.join(dst, n + '.png'); q.save(out, optimize=True)
    print(n, im.size, os.path.getsize(out))
