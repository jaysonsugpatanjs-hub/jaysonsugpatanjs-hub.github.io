"""dump.py WHO ROUTE [selector]  -> compact DOM outline of the screen"""
import sys
sys.path.insert(0, sys.path[0])
from cap import *
from playwright.sync_api import sync_playwright
JS = r"""(root) => { const out=[]; const walk=(el,d)=>{ if(d>9) return; for(const c of el.children){ const t=c.tagName.toLowerCase();
 if(['svg','path','option','br','strong','em','b'].includes(t)) continue;
 const attrs=[...c.attributes].filter(a=>a.name==='id'||a.name==='class'||a.name.startsWith('data-')||a.name==='name'||a.name==='type'||a.name==='href'||a.name==='aria-label').map(a=>a.value===''?a.name:`${a.name}=${a.value.slice(0,40)}`).join(' ');
 const own=[...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').slice(0,60);
 out.push('  '.repeat(d)+t+(attrs?` [${attrs}]`:'')+(own?` "${own}"`:'')); walk(c,d+1);} }; walk(root,0); return out.join('\n'); }"""
if __name__ == "__main__":
    who, route = sys.argv[1], sys.argv[2]; sel = sys.argv[3] if len(sys.argv) > 3 else ".main"
    with sync_playwright() as p:
        s = Session(p, who); s.go(route, settle=1200)
        print(s.page.eval_on_selector(sel, JS)[:int(sys.argv[4]) if len(sys.argv) > 4 else 6000]); s.close()
