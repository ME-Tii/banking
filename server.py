#!/usr/bin/env python3
import http.server
import json
import os
import random
import string
import urllib.parse
from pathlib import Path
from datetime import datetime, date

DATA_FILE = Path(__file__).parent / "data.json"

sessions = {}

FEE_GIRO = 0.25
FEE_SPARKONTO = 0.50
DEFAULT_INTEREST_PCT = 0.5

def now():
    return datetime.now().strftime("%d.%m.%Y, %H:%M:%S")

def today():
    return date.today().isoformat()

def load_data():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text())
    return {"users": [], "transfers": [], "audit": [], "collectedFees": 0}

def save_data(data):
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))

def audit(data, action, by_name, target_name, detail=""):
    data.setdefault("audit", []).insert(0, {
        "action": action,
        "by": by_name,
        "target": target_name,
        "detail": detail,
        "time": now()
    })

def gen_token():
    return ''.join(random.choices(string.hexdigits, k=32))

def get_user_by_email(data, email):
    for u in data["users"]:
        if u["email"] == email:
            return u
    return None

def get_user_by_id(data, uid):
    for u in data["users"]:
        if u["id"] == uid:
            return u
    return None

def next_id(data):
    ids = [u["id"] for u in data["users"]]
    ids += [u["id"] for u in data.get("deleted_users", [])]
    return max(ids, default=0) + 1

def get_fee(account_type):
    return FEE_GIRO if account_type == "giro" else FEE_SPARKONTO

def check_daily_limit(user, amount):
    if user.get("dailyLimit", 0) <= 0:
        return True
    if user.get("dailyDate") != today():
        user["dailySpent"] = 0
        user["dailyDate"] = today()
    return (user.get("dailySpent", 0) + amount) <= user["dailyLimit"]

def deduct_daily_spent(user, amount):
    if user.get("dailyLimit", 0) > 0:
        if user.get("dailyDate") != today():
            user["dailySpent"] = 0
            user["dailyDate"] = today()
        user["dailySpent"] = user.get("dailySpent", 0) + amount

def migrate_users(data):
    for u in data["users"]:
        if "accountType" not in u:
            u["accountType"] = "giro"
        if "dailyLimit" not in u:
            u["dailyLimit"] = 0
        if "dailySpent" not in u:
            u["dailySpent"] = 0
        if "dailyDate" not in u:
            u["dailyDate"] = ""
        if "beneficiaries" not in u:
            u["beneficiaries"] = []
    for u in data.get("deleted_users", []):
        for k in ("accountType", "dailyLimit", "dailySpent", "dailyDate"):
            if k not in u:
                u[k] = 0 if k in ("dailyLimit", "dailySpent") else ("" if k == "dailyDate" else "giro")
    if "collectedFees" not in data:
        data["collectedFees"] = 0
    if "interestRate" not in data:
        data["interestRate"] = DEFAULT_INTEREST_PCT
    return data

def handle_api(method, path, body, headers):
    data = migrate_users(load_data())
    parts = path.strip("/").split("/")

    if method == "POST" and parts == ["api", "register"]:
        name = body.get("name", "").strip()
        email = body.get("email", "").strip()
        password = body.get("password", "")
        is_admin = body.get("isAdmin", False)
        account_type = body.get("accountType", "giro")
        if account_type not in ("giro", "sparkonto"):
            account_type = "giro"
        if not name or not email or not password:
            return (400, {"error": "Pflichtfelder fehlen"})
        if get_user_by_email(data, email):
            return (409, {"error": "E-Mail bereits registriert"})
        user = {
            "id": next_id(data),
            "name": name,
            "email": email,
            "password": password,
            "balance": 0,
            "isAdmin": is_admin,
            "accountType": account_type,
            "dailyLimit": 0,
            "dailySpent": 0,
            "dailyDate": ""
        }
        data["users"].append(user)
        audit(data, "Registrierung", name, name, f"Kontotyp: {'Girokonto' if account_type == 'giro' else 'Sparkonto'}")
        save_data(data)
        token = gen_token()
        sessions[token] = user["id"]
        return (200, {"token": token, "user": {k: v for k, v in user.items() if k != "password"}})

    if method == "POST" and parts == ["api", "login"]:
        email = body.get("email", "").strip()
        password = body.get("password", "")
        user = get_user_by_email(data, email)
        if not user or user["password"] != password:
            return (401, {"error": "Ungültige E-Mail oder Passwort"})
        token = gen_token()
        sessions[token] = user["id"]
        return (200, {"token": token, "user": {k: v for k, v in user.items() if k != "password"}})

    auth = headers.get("Authorization", "")
    token = auth.replace("Bearer ", "").strip()
    uid = sessions.get(token)
    current_user = get_user_by_id(data, uid) if uid else None
    if not current_user:
        return (401, {"error": "Nicht authentifiziert"})

    if method == "GET" and parts == ["api", "me"]:
        return (200, {k: v for k, v in current_user.items() if k != "password"})

    if method == "POST" and parts == ["api", "change-password"]:
        old_pw = body.get("oldPassword", "")
        new_pw = body.get("newPassword", "")
        if not old_pw or not new_pw:
            return (400, {"error": "Pflichtfelder fehlen"})
        if len(new_pw) < 4:
            return (400, {"error": "Passwort muss mindestens 4 Zeichen haben"})
        if current_user["password"] != old_pw:
            return (401, {"error": "Aktuelles Passwort ist falsch"})
        current_user["password"] = new_pw
        audit(data, "Passwort geändert", current_user["name"], current_user["name"])
        save_data(data)
        return (200, {"ok": True})

    if method == "GET" and parts == ["api", "users"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        return (200, {"users": data["users"], "collectedFees": data.get("collectedFees", 0)})

    if method == "POST" and parts == ["api", "users"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        name = body.get("name", "").strip()
        email = body.get("email", "").strip()
        password = body.get("password", "")
        deposit = float(body.get("deposit", 0))
        is_admin = body.get("isAdmin", False)
        account_type = body.get("accountType", "giro")
        if account_type not in ("giro", "sparkonto"):
            account_type = "giro"
        if not name or not email or not password:
            return (400, {"error": "Pflichtfelder fehlen"})
        if get_user_by_email(data, email):
            return (409, {"error": "E-Mail existiert bereits"})
        user = {
            "id": next_id(data),
            "name": name,
            "email": email,
            "password": password,
            "balance": deposit,
            "isAdmin": is_admin,
            "accountType": account_type,
            "dailyLimit": 0,
            "dailySpent": 0,
            "dailyDate": ""
        }
        data["users"].append(user)
        audit(data, "Benutzer erstellt", current_user["name"], name, f"Startguthaben: {deposit}€, Kontotyp: {'Girokonto' if account_type == 'giro' else 'Sparkonto'}")
        save_data(data)
        return (200, {"user": {k: v for k, v in user.items() if k != "password"}})

    if method == "DELETE" and len(parts) == 3 and parts[:2] == ["api", "users"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        uid_del = int(parts[2])
        user_del = get_user_by_id(data, uid_del)
        if not user_del:
            return (404, {"error": "Benutzer nicht gefunden"})
        if user_del["id"] == current_user["id"]:
            return (400, {"error": "Kann sich nicht selbst löschen"})
        data["users"] = [u for u in data["users"] if u["id"] != uid_del]
        data["transfers"] = [t for t in data["transfers"] if t["fromName"] != user_del["name"] and t["toName"] != user_del["name"]]
        data.setdefault("deleted_users", []).append(user_del)
        audit(data, "Benutzer gelöscht", current_user["name"], user_del["name"], f"Kontostand bei Löschung: {user_del['balance']}€")
        save_data(data)
        return (200, {"ok": True})

    if method == "GET" and parts == ["api", "users", "deleted"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        return (200, {"users": data.get("deleted_users", [])})

    if method == "POST" and len(parts) == 4 and parts[:2] == ["api", "users"] and parts[3] == "restore":
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        uid_restore = int(parts[2])
        deleted = data.get("deleted_users", [])
        user_restore = None
        for i, u in enumerate(deleted):
            if u["id"] == uid_restore:
                user_restore = deleted.pop(i)
                break
        if not user_restore:
            return (404, {"error": "Gelöschter Benutzer nicht gefunden"})
        data["users"].append(user_restore)
        audit(data, "Benutzer wiederhergestellt", current_user["name"], user_restore["name"], f"Kontostand bei Wiederherstellung: {user_restore['balance']}€")
        save_data(data)
        return (200, {"ok": True})

    if method == "PUT" and len(parts) == 4 and parts[:2] == ["api", "users"] and parts[3] == "settings":
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        uid_target = int(parts[2])
        target = get_user_by_id(data, uid_target)
        if not target:
            return (404, {"error": "Benutzer nicht gefunden"})
        if "accountType" in body:
            at = body["accountType"]
            if at in ("giro", "sparkonto"):
                target["accountType"] = at
        if "dailyLimit" in body:
            target["dailyLimit"] = float(body["dailyLimit"])
        if "dailySpent" in body:
            target["dailySpent"] = 0
            target["dailyDate"] = ""
        audit(data, "Einstellungen geändert", current_user["name"], target["name"],
              f"Kontotyp: {target['accountType']}, Tageslimit: {target['dailyLimit']}€")
        save_data(data)
        return (200, {"ok": True})

    def do_transfer(from_user, to_user, amount, reason, is_admin_action=False):
        fee = get_fee(from_user.get("accountType", "giro"))
        total_cost = amount + fee
        if from_user["balance"] < total_cost:
            return None, None, f"Nicht genügend Guthaben (inkl. {fee}€ Gebühr)"
        if not check_daily_limit(from_user, amount):
            return None, None, "Tageslimit überschritten"
        from_user["balance"] -= total_cost
        to_user["balance"] += amount
        deduct_daily_spent(from_user, amount)
        data["collectedFees"] = data.get("collectedFees", 0) + fee
        entry = {
            "fromName": from_user["name"],
            "toName": to_user["name"],
            "amount": amount,
            "fee": fee,
            "reason": reason,
            "time": now()
        }
        data["transfers"].insert(0, entry)
        by = current_user["name"] if is_admin_action else from_user["name"]
        audit(data, "Überweisung", by, f"{from_user['name']} -> {to_user['name']}",
              f"{amount}€ (Gebühr: {fee}€) - {reason}")
        return entry, from_user["balance"], None

    if method == "POST" and parts == ["api", "transfer"]:
        to_id = int(body.get("toId"))
        amount = float(body.get("amount"))
        reason = body.get("reason", "")
        to_user = get_user_by_id(data, to_id)
        if not to_user:
            return (404, {"error": "Empfänger nicht gefunden"})
        if current_user["id"] == to_user["id"]:
            return (400, {"error": "Kann nicht an sich selbst senden"})
        entry, balance, err = do_transfer(current_user, to_user, amount, reason, False)
        if err:
            return (400, {"error": err})
        save_data(data)
        return (200, {"fromBalance": balance, "toBalance": to_user["balance"]})

    if method == "POST" and parts == ["api", "admin-transfer"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        from_id = int(body.get("fromId"))
        to_id = int(body.get("toId"))
        amount = float(body.get("amount"))
        reason = body.get("reason", "")
        from_user = get_user_by_id(data, from_id)
        to_user = get_user_by_id(data, to_id)
        if not from_user or not to_user:
            return (404, {"error": "Benutzer nicht gefunden"})
        if from_user["id"] == to_user["id"]:
            return (400, {"error": "Kann nicht an sich selbst senden"})
        entry, balance, err = do_transfer(from_user, to_user, amount, reason, True)
        if err:
            return (400, {"error": err})
        save_data(data)
        return (200, {"ok": True})

    if method == "POST" and parts == ["api", "reverse-transfer"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        time_ref = body.get("time")
        if not time_ref:
            return (400, {"error": "Transaktionszeit fehlt"})
        original = None
        for t in data["transfers"]:
            if t["time"] == time_ref:
                original = t
                break
        if not original:
            return (404, {"error": "Transaktion nicht gefunden"})
        if original.get("reversed"):
            return (400, {"error": "Transaktion bereits storniert"})
        from_user = to_user = None
        for u in data["users"]:
            if u["name"] == original["fromName"]:
                from_user = u
            if u["name"] == original["toName"]:
                to_user = u
        if not from_user and not to_user:
            return (400, {"error": "Keiner der Beteiligten existiert mehr"})
        amount = original["amount"]
        fee = original.get("fee", 0)
        if from_user:
            from_user["balance"] += amount + fee
        if to_user:
            to_user["balance"] -= amount
        data["collectedFees"] = data.get("collectedFees", 0) - fee
        original["reversed"] = True
        data["transfers"].insert(0, {
            "fromName": original["toName"],
            "toName": original["fromName"],
            "amount": amount,
            "fee": 0,
            "reason": "Stornierung: " + (original.get("reason", "")),
            "time": now(),
            "reversal": True
        })
        audit(data, "Stornierung", current_user["name"],
              f"{original['fromName']} -> {original['toName']}",
              f"{amount}€ storniert (Gebühr: {fee}€)")
        save_data(data)
        return (200, {"ok": True})

    if method == "POST" and parts == ["api", "withdraw"]:
        target_id = int(body.get("userId", current_user["id"]))
        amount = float(body.get("amount", 0))
        reason = body.get("reason", "Auszahlung")
        target = get_user_by_id(data, target_id)
        if not target:
            return (404, {"error": "Benutzer nicht gefunden"})
        if not current_user["isAdmin"] and target["id"] != current_user["id"]:
            return (403, {"error": "Kann nur vom eigenen Konto abheben"})
        if amount <= 0:
            return (400, {"error": "Ungültiger Betrag"})
        if target["balance"] < amount:
            return (400, {"error": "Nicht genügend Guthaben"})
        target["balance"] -= amount
        data["transfers"].insert(0, {
            "fromName": target["name"],
            "toName": "Auszahlung",
            "amount": amount,
            "fee": 0,
            "reason": reason,
            "time": now()
        })
        audit(data, "Auszahlung", current_user["name"], target["name"], f"{amount}€ - {reason}")
        save_data(data)
        return (200, {"ok": True, "balance": target["balance"]})

    if method == "POST" and parts == ["api", "deposit"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        target_id = int(body.get("userId"))
        amount = float(body.get("amount", 0))
        reason = body.get("reason", "Einzahlung")
        target = get_user_by_id(data, target_id)
        if not target:
            return (404, {"error": "Benutzer nicht gefunden"})
        if amount <= 0:
            return (400, {"error": "Ungültiger Betrag"})
        target["balance"] += amount
        data["transfers"].insert(0, {
            "fromName": "Einzahlung",
            "toName": target["name"],
            "amount": amount,
            "fee": 0,
            "reason": reason,
            "time": now()
        })
        audit(data, "Einzahlung", current_user["name"], target["name"], f"{amount}€ - {reason}")
        save_data(data)
        return (200, {"ok": True, "balance": target["balance"]})

    if method == "POST" and parts == ["api", "interest"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        total_interest = 0
        rate = data.get("interestRate", DEFAULT_INTEREST_PCT) / 100
        for u in data["users"]:
            if u.get("accountType") == "sparkonto" and u["balance"] > 0:
                interest = round(u["balance"] * rate, 2)
                if interest > 0:
                    u["balance"] += interest
                    total_interest += interest
                    data["transfers"].append({
                        "fromName": "Zinsen",
                        "toName": u["name"],
                        "amount": interest,
                        "fee": 0,
                        "reason": f"{data.get('interestRate', DEFAULT_INTEREST_PCT)}% Sparkonto-Zinsen",
                        "time": now()
                    })
        if total_interest > 0:
            audit(data, "Zinsen gutgeschrieben", "System", f"{len([u for u in data['users'] if u.get('accountType') == 'sparkonto' and u['balance'] > 0])} Sparkonten", f"Zinssatz: {data.get('interestRate', DEFAULT_INTEREST_PCT)}%, Gesamt: {round(total_interest, 2)}€")
        save_data(data)
        return (200, {"ok": True, "totalInterest": round(total_interest, 2)})

    if method == "GET" and parts == ["api", "transfers"]:
        return (200, {"transfers": data["transfers"]})

    if method == "GET" and len(parts) == 3 and parts[:2] == ["api", "transfers"]:
        uid_tx = int(parts[2])
        user_tx = get_user_by_id(data, uid_tx)
        if not user_tx:
            return (404, {"error": "Benutzer nicht gefunden"})
        txs = [t for t in data["transfers"] if t["fromName"] == user_tx["name"] or t["toName"] == user_tx["name"]]
        return (200, {"transfers": txs, "user": {k: v for k, v in user_tx.items() if k != "password"}})

    if method == "GET" and len(parts) == 3 and parts[:2] == ["api", "statement"]:
        uid_stmt = int(parts[2])
        if not current_user["isAdmin"] and current_user["id"] != uid_stmt:
            return (403, {"error": "Zugriff verweigert"})
        user_stmt = get_user_by_id(data, uid_stmt)
        if not user_stmt:
            return (404, {"error": "Benutzer nicht gefunden"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(headers.get("X-Query", "")).query)
        from_date = body.get("from", "") if method == "POST" else ""
        to_date = body.get("to", "") if method == "POST" else ""
        txs = [t for t in data["transfers"] if t["fromName"] == user_stmt["name"] or t["toName"] == user_stmt["name"]]
        if from_date:
            txs = [t for t in txs if t["time"] >= from_date]
        if to_date:
            txs = [t for t in txs if t["time"] <= to_date]
        return (200, {"user": {k: v for k, v in user_stmt.items() if k != "password"}, "transfers": txs})

    if method == "POST" and parts == ["api", "statement"]:
        uid_stmt = int(body.get("userId"))
        from_date = body.get("from", "")
        to_date = body.get("to", "")
        if not current_user["isAdmin"] and current_user["id"] != uid_stmt:
            return (403, {"error": "Zugriff verweigert"})
        user_stmt = get_user_by_id(data, uid_stmt)
        if not user_stmt:
            return (404, {"error": "Benutzer nicht gefunden"})
        txs = [t for t in data["transfers"] if t["fromName"] == user_stmt["name"] or t["toName"] == user_stmt["name"]]
        if from_date:
            txs = [t for t in txs if t["time"] >= from_date]
        if to_date:
            txs = [t for t in txs if t["time"] <= to_date]
        return (200, {"user": {k: v for k, v in user_stmt.items() if k != "password"}, "transfers": txs})

    if method == "GET" and parts == ["api", "beneficiaries"]:
        uids = current_user.get("beneficiaries", [])
        benef = [get_user_by_id(data, bid) for bid in uids]
        benef = [{"id": b["id"], "name": b["name"], "email": b["email"]} for b in benef if b]
        return (200, {"beneficiaries": benef})

    if method == "POST" and parts == ["api", "beneficiaries"]:
        target_id = int(body.get("userId"))
        target = get_user_by_id(data, target_id)
        if not target:
            return (404, {"error": "Benutzer nicht gefunden"})
        if target["id"] == current_user["id"]:
            return (400, {"error": "Kann nicht sich selbst hinzufügen"})
        current_user.setdefault("beneficiaries", [])
        if target_id in current_user["beneficiaries"]:
            return (200, {"ok": True})
        current_user["beneficiaries"].append(target_id)
        save_data(data)
        return (200, {"ok": True})

    if method == "DELETE" and len(parts) == 3 and parts[:2] == ["api", "beneficiaries"]:
        target_id = int(parts[2])
        current_user.setdefault("beneficiaries", [])
        current_user["beneficiaries"] = [b for b in current_user["beneficiaries"] if b != target_id]
        save_data(data)
        return (200, {"ok": True})

    if method == "GET" and parts == ["api", "audit"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        return (200, {"audit": data.get("audit", [])})

    if method == "GET" and parts == ["api", "settings"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        return (200, {"interestRate": data.get("interestRate", DEFAULT_INTEREST_PCT)})

    if method == "PUT" and parts == ["api", "settings"]:
        if not current_user["isAdmin"]:
            return (403, {"error": "Nur für Admins"})
        if "interestRate" in body:
            rate = float(body["interestRate"])
            if rate < 0 or rate > 100:
                return (400, {"error": "Zinssatz muss zwischen 0 und 100 liegen"})
            data["interestRate"] = rate
            audit(data, "Zinssatz geändert", current_user["name"], "System", f"Neuer Zinssatz: {rate}%")
        save_data(data)
        return (200, {"ok": True})

    return (404, {"error": "Nicht gefunden"})

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            code, resp = handle_api("GET", self.path, {}, dict(self.headers))
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode())
            return
        if self.path == "/" or self.path == "/index.html":
            self.path = "/banking.html"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        code, resp = handle_api("POST", self.path, body, dict(self.headers))
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        code, resp = handle_api("PUT", self.path, body, dict(self.headers))
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def do_DELETE(self):
        code, resp = handle_api("DELETE", self.path, {}, dict(self.headers))
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

if __name__ == "__main__":
    os.chdir(Path(__file__).parent)
    port = 8080
    print(f"Server läuft auf http://localhost:{port}")
    http.server.HTTPServer(("0.0.0.0", port), Handler).serve_forever()
