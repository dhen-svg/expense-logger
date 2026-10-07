# Mini App checks with a fake Telegram and fake API. Run: python3 test/ui.test.py
import json, sys
from playwright.sync_api import sync_playwright
URL = "http://app.test/index.html"
HTML = open("/home/claude/out/index.html").read()
OPTIONS = {"categories":[{"id":1,"name":"Active Income","type":"income"},{"id":15,"name":"Financial Obligations","type":"expense"}],
 "subcategories":[{"id":17,"category_id":1,"name":"Routine Base Pay"},{"id":36,"category_id":15,"name":"Taxes & Fees"}],
 "accounts":[{"id":1,"name":"Jago","currency":"IDR","account_type":"spending","show_in_expense_form":True},
             {"id":2,"name":"Stockbit","currency":"IDR","account_type":"investment","show_in_expense_form":False},
             {"id":3,"name":"IBKR","currency":"USD","account_type":"investment","show_in_expense_form":False}],
 "transfers_enabled":True,"spenders":[{"id":1,"name":"Dheny"}],"tags":[]}
res=[]; 
def check(n,c,x=""): res.append(c); print(("PASS " if c else "FAIL ")+n+("" if c else "  "+str(x)))
def stub(start): return "window.Telegram={WebApp:{initData:'x=1',initDataUnsafe:{start_param:%s},ready(){},expand(){},HapticFeedback:{notificationOccurred(){}}}};" % json.dumps(start)
def page(b, w=375, start="", opts=OPTIONS):
    ctx=b.new_context(viewport={"width":w,"height":800}); ctx.add_init_script(stub(start)); p=ctx.new_page()
    p.errs=[]; p.on("pageerror",lambda e:p.errs.append(str(e))); p.on("console",lambda m:p.errs.append(m.text) if m.type=="error" else None)
    p.posts=[]
    def route(r):
        u=r.request.url
        if u.endswith("/index.html"): r.fulfill(body=HTML,content_type="text/html")
        elif u.endswith("/api/options"): r.fulfill(json=opts)
        elif u.endswith("/api/transfers"): p.posts.append(("transfers",r.request.post_data_json)); r.fulfill(json={"ok":True,"transfer":{"txn_no":"T2610001"}})
        elif u.endswith("/api/expenses"): p.posts.append(("expenses",r.request.post_data_json)); r.fulfill(json={"ok":True,"expense":{}})
        elif "telegram.org" in u: r.fulfill(body="",content_type="text/javascript")
        else: r.continue_()
    p.route("**/*",route); p.goto(URL); p.wait_for_selector("#account option", state="attached"); return p
with sync_playwright() as pw:
    b=pw.chromium.launch()
    p=page(b)
    check("transaction mode by default", p.evaluate("!document.getElementById('form-txn').hidden && document.getElementById('form-transfer').hidden"))
    check("expense form lists only spending accounts", p.evaluate("[...document.querySelectorAll('#account option')].map(o=>o.textContent).join()")=="Jago")
    p.click("#mode-transfer")
    check("transfer mode shows transfer form, hides expense form", p.evaluate("document.getElementById('form-txn').hidden && !document.getElementById('form-transfer').hidden"))
    check("title and button follow the mode", p.inner_text("#title")=="New Transfer" and p.inner_text("#save")=="Save transfer")
    check("transfer selects list every account, USD labelled", p.evaluate("[...document.querySelectorAll('#from_account option')].map(o=>o.textContent).join('|')")=="Choose account|Jago|Stockbit|IBKR (USD)")
    p.click("#save"); check("empty save is blocked with a message", "Fill in" in p.inner_text("#status") and not p.posts)
    p.select_option("#from_account","1"); p.select_option("#to_account","1"); p.fill("#amount_out","1000000"); p.click("#save")
    check("same account is blocked", "different accounts" in p.inner_text("#status") and not p.posts)
    p.select_option("#to_account","2")
    check("same-currency pair hides amount received", p.evaluate("document.getElementById('in_wrap').hidden"))
    check("IDR source shows the fee-as-expense hint", "Taxes & Fees expense" in p.inner_text("#fee_hint"))
    p.select_option("#to_account","3")
    check("IDR to USD shows amount received in USD", p.evaluate("!document.getElementById('in_wrap').hidden") and "USD" in p.inner_text("#label_in"))
    p.click("#save"); check("cross-currency without amount received is blocked", "amount received" in p.inner_text("#status") and not p.posts)
    p.fill("#amount_in","56.2"); p.fill("#fee","6500"); p.fill("#t_description","IBKR top up"); p.click("#save"); p.wait_for_selector("#status.success")
    kind,pl=p.posts[0]
    check("payload sent to /api/transfers with both amounts and fee", kind=="transfers" and pl["from_account_id"]=="1" and pl["to_account_id"]=="3" and pl["amount_out"]=="1000000" and pl["amount_in"]=="56.2" and pl["fee_amount"]=="6500", pl)
    check("success message shows the transfer number", "T2610001" in p.inner_text("#status"))
    check("amounts cleared after save", p.input_value("#amount_out")=="" and p.input_value("#fee")=="")
    p.select_option("#from_account","3"); p.select_option("#to_account","1")
    check("USD source shows the ledger-is-IDR fee hint", "stays on the transfer only" in p.inner_text("#fee_hint"))
    p.click("#mode-txn"); p.select_option("#category","1"); p.select_option("#subcategory","17"); p.fill("#amount","5000000"); p.click("#save"); p.wait_for_selector("#status.success")
    check("a normal transaction still posts to /api/expenses", p.posts[-1][0]=="expenses" and p.posts[-1][1]["account_id"]=="1")
    check("no console errors", not p.errs, p.errs)
    # layout and tap targets, transfer mode, narrow phones
    p.click("#mode-transfer")
    for w in (320,360,375,414):
        p.set_viewport_size({"width":w,"height":800})
        check(f"no horizontal overflow at {w}px", not p.evaluate("document.documentElement.scrollWidth>innerWidth"))
    small=p.evaluate("[...document.querySelectorAll('button,input:not([type=checkbox]),select')].filter(e=>e.offsetParent).map(e=>[e.id,Math.round(e.getBoundingClientRect().height)]).filter(x=>x[1]<44)")
    check("all visible controls are at least 44px tall", not small, small)
    # start parameter opens transfer mode
    p2=page(b,start="transfer"); check("startapp=transfer opens transfer mode", p2.inner_text("#title")=="New Transfer")
    # migration not run yet
    o=dict(OPTIONS); o["transfers_enabled"]=False; p3=page(b,opts=o)
    check("transfers hidden until the migration has run", p3.evaluate("document.getElementById('mode-switch').hidden"))
    p4=page(b,start="transfer",opts=o); check("startapp=transfer is ignored when transfers are off", p4.inner_text("#title")=="New Transaction")
    b.close()
print(f"\n{sum(res)} passed, {len(res)-sum(res)} failed"); sys.exit(0 if all(res) else 1)
