"""Version local asset URLs in index.html and build the self-contained HTML."""
import base64
import hashlib
import re
from pathlib import Path

root = Path(__file__).resolve().parent
html = (root / 'index.html').read_text()
for name in ('style.css', 'visual.css', 'data.js', 'app.js', 'visual.js'):
    version = hashlib.sha256((root / name).read_bytes()).hexdigest()[:10]
    html = re.sub(r'((?:href|src)="' + re.escape(name) + r')(?:\?[^"\s]*)?"',
                  lambda match: match[1] + '?v=' + version + '"', html)
(root / 'index.html').write_text(html)
font = base64.b64encode((root / 'assets/GolosText-variable.ttf').read_bytes()).decode()
for name in ('style.css', 'visual.css'):
    css = (root / name).read_text().replace(
        'url("assets/GolosText-variable.ttf")',
        f'url("data:font/ttf;base64,{font}")',
    )
    html = re.sub(r'<link rel="stylesheet" href="' + re.escape(name) + r'(?:\?[^"\s]*)?">',
                  lambda _: f'<style>\n{css}\n</style>', html)

scripts = []
for name in ('data.js', 'app.js', 'visual.js'):
    html = re.sub(r'<script src="' + re.escape(name) + r'(?:\?[^"\s]*)?" defer></script>\n', '', html)
    scripts.append('<script>\n' + (root / name).read_text() + '\n</script>')

# Keep data, controller and presentation in the same order as the editable page.
license_text = (root / 'assets/OFL-Golos-Text.txt').read_text()
scripts.append('<script type="text/plain" id="golos-text-license">\n' + license_text + '\n</script>')
html = html.replace('href="./index.html', 'href="./PlaceLens-visual.html')
html = html.replace('</body>', '\n'.join(scripts) + '\n</body>')
(root / 'PlaceLens-visual.html').write_text(html)
