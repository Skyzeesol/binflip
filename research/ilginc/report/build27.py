import math, html
import os; S = os.path.dirname(os.path.abspath(__file__)) + '/'
style = open(S + 'style.css').read()

def box_chart(title_rows, scale_max, ticks, fmt, log=False, width=860, label_w=150, unit=""):
    """title_rows: list of (label, color, [q10,q25,med,q75,q90])."""
    plot_w = width - label_w - 30
    def x(v):
        if log:
            v = math.log10(max(v, 1))
            return label_w + plot_w * v / scale_max
        return label_w + plot_w * min(v, scale_max) / scale_max
    rows_h = 34
    h = 30 + rows_h * len(title_rows) + 30
    out = [f'<svg viewBox="0 0 {width} {h}" role="img">']
    for t in ticks:
        tx = x(t)
        out.append(f'<line x1="{tx:.1f}" y1="20" x2="{tx:.1f}" y2="{h-28}" stroke="var(--line)"/>')
        out.append(f'<text x="{tx:.1f}" y="{h-12}" text-anchor="middle" font-size="11" class="m">{fmt(t)}</text>')
    for i, (lab, col, q) in enumerate(title_rows):
        y = 30 + i * rows_h
        out.append(f'<text x="0" y="{y+15}" font-size="12">{html.escape(lab)}</text>')
        out.append(f'<line x1="{x(q[0]):.1f}" y1="{y+10}" x2="{x(q[4]):.1f}" y2="{y+10}" stroke="{col}" stroke-width="2"/>')
        out.append(f'<rect x="{x(q[1]):.1f}" y="{y}" width="{max(2, x(q[3])-x(q[1])):.1f}" height="20" rx="3" fill="{col}" opacity=".28" stroke="{col}"/>')
        out.append(f'<line x1="{x(q[2]):.1f}" y1="{y-3}" x2="{x(q[2]):.1f}" y2="{y+23}" stroke="{col}" stroke-width="3"/>')
        out.append(f'<text x="{min(x(q[2])+6, width-60):.1f}" y="{y-5}" font-size="11">{fmt(q[2])}{unit}</text>')
    out.append('</svg>')
    return '\n'.join(out)

money = lambda v: '$' + (f'{v/1000:.0f}k' if v >= 10000 else f'{v/1000:.1f}k' if v >= 1000 else f'{v:.0f}')
spike = box_chart([("açılış", "var(--sol)", [0.36, 0.92, 2.9, 12, 12]), ("kontrol", "var(--muted)", [0, 0.1, 0.57, 1.3, 2.48])],
                  12, [0, 1, 2, 4, 6, 8, 10, 12], lambda v: f'{v:g}', unit="×")
v5 = box_chart([("açılış", "var(--sol)", [1, 83, 1346, 6002, 17544]), ("kontrol", "var(--muted)", [1, 1, 123, 1187, 5555])],
               5, [1, 10, 100, 1000, 10000, 100000], money, log=True, width=420, label_w=70)
# log chart labels: ticks are exponents; medians are raw values
rng = box_chart([("açılış", "var(--sol)", [0.47, 1.98, 11.64, 32.14, 67.32]), ("kontrol", "var(--muted)", [0.91, 3.09, 7.21, 14.49, 29.09])],
                70, [0, 20, 40, 60], lambda v: f'%{v:g}', width=420, label_w=70)
lotrng = box_chart([("7 SOL (292)", "var(--sol)", [0.19, 0.43, 1.23, 3.12, 10.08]), ("2 SOL (191)", "var(--tok)", [0.68, 3.31, 29.57, 55.45, 138.04]), ("1 SOL (711)", "var(--tok)", [2.57, 8.38, 20.44, 37.61, 82.49])],
                   70, [0, 10, 20, 30, 40, 50, 60, 70], lambda v: f'%{v:g}')
exitspike = box_chart([("kapanış", "var(--loss)", [0, 0.12, 0.62, 1.48, 3.89]), ("orta", "var(--muted)", [0, 0, 0.46, 1.28, 2.66])],
                      4, [0, 1, 2, 3, 4], lambda v: f'{v:g}', unit="×", width=420, label_w=70)
exitrng = box_chart([("kapanış", "var(--loss)", [2.89, 7.69, 19.27, 43.66, 91.27]), ("orta", "var(--muted)", [1.04, 5.68, 17.44, 35.96, 63.2])],
                    70, [0, 20, 40, 60], lambda v: f'%{v:g}', width=420, label_w=70)

def bars(items, maxv=100, width=860, label_w=200):
    plot = width - label_w - 70
    h = 18 + 30 * len(items)
    out = [f'<svg viewBox="0 0 {width} {h}" role="img">']
    for i, (lab, a, b) in enumerate(items):
        y = 8 + i * 30
        out.append(f'<text x="0" y="{y+16}" font-size="12">{html.escape(lab)}</text>')
        out.append(f'<rect x="{label_w}" y="{y}" width="{plot*a/maxv:.1f}" height="10" rx="2" fill="var(--muted)" opacity=".55"/>')
        out.append(f'<text x="{label_w+plot*a/maxv+6:.1f}" y="{y+9}" font-size="10" class="m">%{a:g}</text>')
        out.append(f'<rect x="{label_w}" y="{y+12}" width="{plot*b/maxv:.1f}" height="10" rx="2" fill="var(--sol)"/>')
        out.append(f'<text x="{label_w+plot*b/maxv+6:.1f}" y="{y+21}" font-size="10">%{b:g}</text>')
    out.append('</svg>')
    return '\n'.join(out)

shadow = bars([("Birebir aynı hamle", 69.9, 85.7), ("Doğru taraf", 80.5, 93.3), ("Görmeden kaçırma", 19.5, 5.2), ("Yanlış taraf", 0, 1.2), ("Kural farkı (missed)", 0, 0.2)])

body = open(S + 'body27.html').read()
for k, v in dict(SHADOW=shadow, SPIKE=spike, V5=v5, RNG=rng, LOTRNG=lotrng, EXITSPIKE=exitspike, EXITRNG=exitrng).items():
    body = body.replace('{{' + k + '}}', v)
open('/home/user/binflip/research/ilginc/report/ilginc-guncelleme-27kasim.html', 'w').write(
    '<!doctype html>\n<html lang="tr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>İlginç Analiz Güncellemesi</title>\n' + style + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
print("ok")
