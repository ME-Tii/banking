const http = require("http")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const DIR = __dirname
const PKG = require(path.join(DIR, "package.json"))
let DATA_FILE = path.join(__dirname, "data.json")

const FEE_GIRO = 0.25
const FEE_SPARKONTO = 0.50
const DEFAULT_INTEREST_PCT = 0.5

const sessions = {}
const serverStart = Date.now()

function now() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function today() {
  return new Date().toISOString().split("T")[0]
}

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))
  } catch {
    return { users: [], transfers: [], audit: [], collectedFees: 0 }
  }
}

function seedData(data) {
  if (data.users.length > 0) return
  const id = (n) => ({ id: n + 1, isAdmin: false, accountType: "giro", dailyLimit: 0, dailySpent: 0, dailyDate: "", beneficiaries: [] })
  data.users = [
    { name: "Thomas Seitz", email: "thomasseitz22@gmail.com", password: "password", balance: 5000, isAdmin: true, accountType: "giro", id: 1, dailyLimit: 0, dailySpent: 0, dailyDate: "", beneficiaries: [] },
    { ...id(1), name: "Peter Parker", email: "peterparker@gmail.com", password: "password", balance: 1500 },
    { ...id(2), name: "Alice Müller", email: "alice@test.com", password: "test1234", balance: 2500 },
    { ...id(3), name: "Diana Fischer", email: "diana@test.com", password: "test1234", balance: 3000 },
    { ...id(4), name: "Eva Braun", email: "eva@test.com", password: "test1234", balance: 4000, accountType: "sparkonto" },
    { ...id(5), name: "Frank Klein", email: "frank@test.com", password: "test1234", balance: 2000 },
    { ...id(6), name: "Greta Schulz", email: "greta@test.com", password: "test1234", balance: 3500, accountType: "sparkonto" },
    { ...id(7), name: "Hans Weber", email: "hans@test.com", password: "test1234", balance: 1000 },
  ]
  data.collectedFees = 0
  data.interestRate = 0.5
  saveData(data)
}

let writeQueue = Promise.resolve()

function saveData(data) {
  writeQueue = writeQueue.then(() => {
    try {
      const dir = path.dirname(DATA_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak")
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
    } catch (e) {
      console.error("saveData:", e.message)
    }
  })
}

function audit(data, action, byName, targetName, detail = "") {
  data.audit ??= []
  data.audit.unshift({ action, by: byName, target: targetName, detail, time: now() })
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [token, s] of Object.entries(sessions)) {
    if (now - s.createdAt > SESSION_TTL_MS) delete sessions[token]
  }
}, 60 * 60 * 1000)

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex")
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored.includes(":")) return stored === password
  const [salt, hash] = stored.split(":")
  const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex")
  return hash === computed
}

function isHashed(password) {
  return password.includes(":")
}

function genToken() {
  return crypto.randomBytes(16).toString("hex")
}

function getUserByEmail(data, email) {
  return data.users.find(u => u.email === email)
}

function getUserById(data, uid) {
  return data.users.find(u => u.id === uid)
}

function nextId(data) {
  const ids = data.users.map(u => u.id)
  if (data.deleted_users) ids.push(...data.deleted_users.map(u => u.id))
  return Math.max(0, ...ids) + 1
}

function getFee(accountType) {
  return accountType === "giro" ? FEE_GIRO : FEE_SPARKONTO
}

function checkDailyLimit(user, amount) {
  const limit = user.dailyLimit ?? 0
  if (limit <= 0) return true
  if (user.dailyDate !== today()) {
    user.dailySpent = 0
    user.dailyDate = today()
  }
  return (user.dailySpent ?? 0) + amount <= limit
}

function deductDailySpent(user, amount) {
  const limit = user.dailyLimit ?? 0
  if (limit > 0) {
    if (user.dailyDate !== today()) {
      user.dailySpent = 0
      user.dailyDate = today()
    }
    user.dailySpent = (user.dailySpent ?? 0) + amount
  }
}

function migrateUsers(data) {
  for (const u of data.users) {
    u.accountType ??= "giro"
    u.dailyLimit ??= 0
    u.dailySpent ??= 0
    u.dailyDate ??= ""
    u.beneficiaries ??= []
  }
  for (const u of data.deleted_users ?? []) {
    for (const k of ["accountType", "dailyLimit", "dailySpent", "dailyDate"]) {
      if (!(k in u)) u[k] = k === "accountType" ? "giro" : 0
    }
  }
  data.collectedFees ??= 0
  data.interestRate ??= DEFAULT_INTEREST_PCT
  return data
}

function handleAPI(method, urlPath, body, data) {
  const parts = urlPath.replace(/^\/+/, "").split("/")

  // Ping (no auth required)
  if (method === "GET" && parts.join("/") === "api/ping") {
    return [200, { time: serverStart }]
  }

  // Version info (no auth required)
  if (method === "GET" && parts.join("/") === "api/version") {
    const gh = "https://github.com/ME-Tii/banking/releases/download/v" + PKG.version
    return [200, {
      version: PKG.version,
      downloadUrl: "/",
      publicUrl: process.env.PUBLIC_URL || PKG.publicUrl || "",
      downloads: {
        mac: gh + "/Banking.System-" + PKG.version + ".dmg",
        win: gh + "/Banking.System." + PKG.version + ".exe",
        "linux-x64": gh + "/Banking.System-" + PKG.version + ".AppImage",
        "linux-arm64": gh + "/Banking.System-" + PKG.version + "-arm64.AppImage",
      },
      downloadDeb: {
        "linux-x64": gh + "/banking-system_" + PKG.version + "_amd64.deb",
        "linux-arm64": gh + "/banking-system_" + PKG.version + "_arm64.deb",
      },
    }]
  }

  // Auth endpoints (no token required)
  if (method === "POST" && parts.join("/") === "api/register") {
    const name = (body.name ?? "").trim()
    const email = (body.email ?? "").trim()
    const password = body.password ?? ""
    const isAdmin = body.isAdmin ?? false
    let accountType = body.accountType ?? "giro"
    if (!["giro", "sparkonto"].includes(accountType)) accountType = "giro"
    if (!name || !email || !password) return [400, { error: "Pflichtfelder fehlen" }]
    if (getUserByEmail(data, email)) return [409, { error: "E-Mail bereits registriert" }]
    const user = {
      id: nextId(data), name, email, password: hashPassword(password), balance: 0,
      isAdmin, accountType, dailyLimit: 0, dailySpent: 0, dailyDate: "", beneficiaries: []
    }
    data.users.push(user)
    audit(data, "Registrierung", name, name, `Kontotyp: ${accountType === "giro" ? "Girokonto" : "Sparkonto"}`)
    saveData(data)
    const token = genToken()
    sessions[token] = { userId: user.id, createdAt: Date.now() }
    const { password: _, ...safe } = user
    return [200, { token, user: safe }]
  }

  if (method === "POST" && parts.join("/") === "api/login") {
    const email = (body.email ?? "").trim()
    const password = body.password ?? ""
    const user = getUserByEmail(data, email)
    if (!user || !verifyPassword(password, user.password)) return [401, { error: "Ungültige E-Mail oder Passwort" }]
    if (!isHashed(user.password)) {
      user.password = hashPassword(password)
      saveData(data)
    }
    const token = genToken()
    sessions[token] = { userId: user.id, createdAt: Date.now() }
    const { password: _, ...safe } = user
    return [200, { token, user: safe }]
  }

  // Token-based auth
  const authHeader = body._auth ?? ""
  const token = authHeader.replace("Bearer ", "").trim()
  const session = sessions[token]
  if (session && Date.now() - session.createdAt > SESSION_TTL_MS) {
    delete sessions[token]
    return [401, { error: "Sitzung abgelaufen" }]
  }
  const uid = session ? session.userId : null
  const currentUser = uid ? getUserById(data, uid) : null
  if (!currentUser) return [401, { error: "Nicht authentifiziert" }]

  if (method === "GET" && parts.join("/") === "api/me") {
    const { password: _, ...safe } = currentUser
    return [200, safe]
  }

  if (method === "POST" && parts.join("/") === "api/change-password") {
    const oldPw = body.oldPassword ?? ""
    const newPw = body.newPassword ?? ""
    if (!oldPw || !newPw) return [400, { error: "Pflichtfelder fehlen" }]
    if (newPw.length < 4) return [400, { error: "Passwort muss mindestens 4 Zeichen haben" }]
    if (!verifyPassword(oldPw, currentUser.password)) return [401, { error: "Aktuelles Passwort ist falsch" }]
    currentUser.password = hashPassword(newPw)
    audit(data, "Passwort geändert", currentUser.name, currentUser.name)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "GET" && parts.join("/") === "api/users") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    return [200, { users: data.users, collectedFees: data.collectedFees ?? 0 }]
  }

  if (method === "POST" && parts.join("/") === "api/users") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const name = (body.name ?? "").trim()
    const email = (body.email ?? "").trim()
    const password = body.password ?? ""
    const deposit = parseFloat(body.deposit ?? 0)
    const isAdmin = body.isAdmin ?? false
    let accountType = body.accountType ?? "giro"
    if (!["giro", "sparkonto"].includes(accountType)) accountType = "giro"
    if (!name || !email || !password) return [400, { error: "Pflichtfelder fehlen" }]
    if (getUserByEmail(data, email)) return [409, { error: "E-Mail existiert bereits" }]
    const user = {
      id: nextId(data), name, email, password: hashPassword(password), balance: deposit,
      isAdmin, accountType, dailyLimit: 0, dailySpent: 0, dailyDate: "", beneficiaries: []
    }
    data.users.push(user)
    audit(data, "Benutzer erstellt", currentUser.name, name, `Startguthaben: ${deposit}€, Kontotyp: ${accountType === "giro" ? "Girokonto" : "Sparkonto"}`)
    saveData(data)
    const { password: _, ...safe } = user
    return [200, { user: safe }]
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "users" && parts.length === 3 && parts[2] !== "deleted") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const uidDel = parseInt(parts[2])
    const userDel = getUserById(data, uidDel)
    if (!userDel) return [404, { error: "Benutzer nicht gefunden" }]
    if (userDel.id === currentUser.id) return [400, { error: "Kann sich nicht selbst löschen" }]
    data.users = data.users.filter(u => u.id !== uidDel)
    data.transfers = data.transfers.filter(t => t.fromName !== userDel.name && t.toName !== userDel.name)
    data.deleted_users ??= []
    data.deleted_users.push(userDel)
    audit(data, "Benutzer gelöscht", currentUser.name, userDel.name, `Kontostand bei Löschung: ${userDel.balance}€`)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "GET" && parts.join("/") === "api/users/deleted") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    return [200, { users: data.deleted_users ?? [] }]
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "users" && parts.length === 4 && parts[3] === "restore") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const uidRestore = parseInt(parts[2])
    const deleted = data.deleted_users ?? []
    const idx = deleted.findIndex(u => u.id === uidRestore)
    if (idx === -1) return [404, { error: "Gelöschter Benutzer nicht gefunden" }]
    const userRestore = deleted.splice(idx, 1)[0]
    data.users.push(userRestore)
    audit(data, "Benutzer wiederhergestellt", currentUser.name, userRestore.name, `Kontostand bei Wiederherstellung: ${userRestore.balance}€`)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "users" && parts.length === 4 && parts[3] === "settings") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const uidTarget = parseInt(parts[2])
    const target = getUserById(data, uidTarget)
    if (!target) return [404, { error: "Benutzer nicht gefunden" }]
    if (body.accountType && ["giro", "sparkonto"].includes(body.accountType)) target.accountType = body.accountType
    if (body.dailyLimit !== undefined) target.dailyLimit = parseFloat(body.dailyLimit)
    if (body.dailySpent !== undefined) { target.dailySpent = 0; target.dailyDate = "" }
    audit(data, "Einstellungen geändert", currentUser.name, target.name, `Kontotyp: ${target.accountType}, Tageslimit: ${target.dailyLimit}€`)
    saveData(data)
    return [200, { ok: true }]
  }

  function doTransfer(fromUser, toUser, amount, reason, isAdminAction = false) {
    const fee = getFee(fromUser.accountType ?? "giro")
    const totalCost = amount + fee
    if (fromUser.balance < totalCost) return [null, null, `Nicht genügend Guthaben (inkl. ${fee}€ Gebühr)`]
    if (!checkDailyLimit(fromUser, amount)) return [null, null, "Tageslimit überschritten"]
    fromUser.balance -= totalCost
    toUser.balance += amount
    deductDailySpent(fromUser, amount)
    data.collectedFees = (data.collectedFees ?? 0) + fee
    const entry = { fromName: fromUser.name, toName: toUser.name, amount, fee, reason, time: now() }
    data.transfers.unshift(entry)
    const by = isAdminAction ? currentUser.name : fromUser.name
    audit(data, "Überweisung", by, `${fromUser.name} -> ${toUser.name}`, `${amount}€ (Gebühr: ${fee}€) - ${reason}`)
    return [entry, fromUser.balance, null]
  }

  if (method === "POST" && parts.join("/") === "api/transfer") {
    const toId = parseInt(body.toId)
    const amount = parseFloat(body.amount)
    const reason = body.reason ?? ""
    const toUser = getUserById(data, toId)
    if (!toUser) return [404, { error: "Empfänger nicht gefunden" }]
    if (currentUser.id === toUser.id) return [400, { error: "Kann nicht an sich selbst senden" }]
    const [entry, balance, err] = doTransfer(currentUser, toUser, amount, reason, false)
    if (err) return [400, { error: err }]
    saveData(data)
    return [200, { fromBalance: balance, toBalance: toUser.balance }]
  }

  if (method === "POST" && parts.join("/") === "api/admin-transfer") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const fromId = parseInt(body.fromId)
    const toId = parseInt(body.toId)
    const amount = parseFloat(body.amount)
    const reason = body.reason ?? ""
    const fromUser = getUserById(data, fromId)
    const toUser = getUserById(data, toId)
    if (!fromUser || !toUser) return [404, { error: "Benutzer nicht gefunden" }]
    if (fromUser.id === toUser.id) return [400, { error: "Kann nicht an sich selbst senden" }]
    const [entry, balance, err] = doTransfer(fromUser, toUser, amount, reason, true)
    if (err) return [400, { error: err }]
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "POST" && parts.join("/") === "api/reverse-transfer") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const timeRef = body.time
    if (!timeRef) return [400, { error: "Transaktionszeit fehlt" }]
    const original = data.transfers.find(t => t.time === timeRef)
    if (!original) return [404, { error: "Transaktion nicht gefunden" }]
    if (original.reversed) return [400, { error: "Transaktion bereits storniert" }]
    let fromUser = null, toUser = null
    for (const u of data.users) {
      if (u.name === original.fromName) fromUser = u
      if (u.name === original.toName) toUser = u
    }
    if (!fromUser && !toUser) return [400, { error: "Keiner der Beteiligten existiert mehr" }]
    const amount = original.amount
    const fee = original.fee ?? 0
    if (fromUser) fromUser.balance += amount + fee
    if (toUser) toUser.balance -= amount
    data.collectedFees = (data.collectedFees ?? 0) - fee
    original.reversed = true
    data.transfers.unshift({
      fromName: original.toName, toName: original.fromName, amount, fee: 0,
      reason: "Stornierung: " + (original.reason ?? ""), time: now(), reversal: true
    })
    audit(data, "Stornierung", currentUser.name, `${original.fromName} -> ${original.toName}`, `${amount}€ storniert (Gebühr: ${fee}€)`)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "POST" && parts.join("/") === "api/withdraw") {
    const targetId = parseInt(body.userId ?? currentUser.id)
    const amount = parseFloat(body.amount ?? 0)
    const reason = body.reason ?? "Auszahlung"
    const target = getUserById(data, targetId)
    if (!target) return [404, { error: "Benutzer nicht gefunden" }]
    if (!currentUser.isAdmin && target.id !== currentUser.id) return [403, { error: "Kann nur vom eigenen Konto abheben" }]
    if (amount <= 0) return [400, { error: "Ungültiger Betrag" }]
    if (target.balance < amount) return [400, { error: "Nicht genügend Guthaben" }]
    target.balance -= amount
    data.transfers.unshift({ fromName: target.name, toName: "Auszahlung", amount, fee: 0, reason, time: now() })
    audit(data, "Auszahlung", currentUser.name, target.name, `${amount}€ - ${reason}`)
    saveData(data)
    return [200, { ok: true, balance: target.balance }]
  }

  if (method === "POST" && parts.join("/") === "api/deposit") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    const targetId = parseInt(body.userId)
    const amount = parseFloat(body.amount ?? 0)
    const reason = body.reason ?? "Einzahlung"
    const target = getUserById(data, targetId)
    if (!target) return [404, { error: "Benutzer nicht gefunden" }]
    if (amount <= 0) return [400, { error: "Ungültiger Betrag" }]
    target.balance += amount
    data.transfers.unshift({ fromName: "Einzahlung", toName: target.name, amount, fee: 0, reason, time: now() })
    audit(data, "Einzahlung", currentUser.name, target.name, `${amount}€ - ${reason}`)
    saveData(data)
    return [200, { ok: true, balance: target.balance }]
  }

  if (method === "POST" && parts.join("/") === "api/interest") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    let totalInterest = 0
    const rate = (data.interestRate ?? DEFAULT_INTEREST_PCT) / 100
    for (const u of data.users) {
      if (u.accountType === "sparkonto" && u.balance > 0) {
        const interest = Math.round(u.balance * rate * 100) / 100
        if (interest > 0) {
          u.balance += interest
          totalInterest += interest
          data.transfers.push({ fromName: "Zinsen", toName: u.name, amount: interest, fee: 0, reason: `${data.interestRate ?? DEFAULT_INTEREST_PCT}% Sparkonto-Zinsen`, time: now() })
        }
      }
    }
    if (totalInterest > 0) {
      const count = data.users.filter(u => u.accountType === "sparkonto" && u.balance > 0).length
      audit(data, "Zinsen gutgeschrieben", "System", `${count} Sparkonten`, `Zinssatz: ${data.interestRate ?? DEFAULT_INTEREST_PCT}%, Gesamt: ${Math.round(totalInterest * 100) / 100}€`)
    }
    saveData(data)
    return [200, { ok: true, totalInterest: Math.round(totalInterest * 100) / 100 }]
  }

  if (method === "GET" && parts.join("/") === "api/transfers") {
    return [200, { transfers: data.transfers }]
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "transfers" && parts.length === 3) {
    const uidTx = parseInt(parts[2])
    const userTx = getUserById(data, uidTx)
    if (!userTx) return [404, { error: "Benutzer nicht gefunden" }]
    const txs = data.transfers.filter(t => t.fromName === userTx.name || t.toName === userTx.name)
    const { password: _, ...safe } = userTx
    return [200, { transfers: txs, user: safe }]
  }

  if (method === "POST" && parts.join("/") === "api/statement") {
    const uidStmt = parseInt(body.userId)
    const fromDate = body.from ?? ""
    const toDate = body.to ?? ""
    if (!currentUser.isAdmin && currentUser.id !== uidStmt) return [403, { error: "Zugriff verweigert" }]
    const userStmt = getUserById(data, uidStmt)
    if (!userStmt) return [404, { error: "Benutzer nicht gefunden" }]
    let txs = data.transfers.filter(t => t.fromName === userStmt.name || t.toName === userStmt.name)
    if (fromDate) txs = txs.filter(t => t.time >= fromDate)
    if (toDate) txs = txs.filter(t => t.time <= toDate)
    const { password: _, ...safe } = userStmt
    return [200, { user: safe, transfers: txs }]
  }

  if (method === "GET" && parts.join("/") === "api/beneficiaries") {
    const uids = currentUser.beneficiaries ?? []
    const benef = uids.map(bid => getUserById(data, bid)).filter(Boolean).map(b => ({ id: b.id, name: b.name, email: b.email }))
    return [200, { beneficiaries: benef }]
  }

  if (method === "POST" && parts.join("/") === "api/beneficiaries") {
    const targetId = parseInt(body.userId)
    const target = getUserById(data, targetId)
    if (!target) return [404, { error: "Benutzer nicht gefunden" }]
    if (target.id === currentUser.id) return [400, { error: "Kann nicht sich selbst hinzufügen" }]
    currentUser.beneficiaries ??= []
    if (currentUser.beneficiaries.includes(targetId)) return [200, { ok: true }]
    currentUser.beneficiaries.push(targetId)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "beneficiaries" && parts.length === 3) {
    const targetId = parseInt(parts[2])
    currentUser.beneficiaries ??= []
    currentUser.beneficiaries = currentUser.beneficiaries.filter(b => b !== targetId)
    saveData(data)
    return [200, { ok: true }]
  }

  if (method === "GET" && parts.join("/") === "api/audit") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    return [200, { audit: data.audit ?? [] }]
  }

  if (method === "GET" && parts.join("/") === "api/settings") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    return [200, { interestRate: data.interestRate ?? DEFAULT_INTEREST_PCT }]
  }

  if (method === "PUT" && parts.join("/") === "api/settings") {
    if (!currentUser.isAdmin) return [403, { error: "Nur für Admins" }]
    if (body.interestRate !== undefined) {
      const rate = parseFloat(body.interestRate)
      if (rate < 0 || rate > 100) return [400, { error: "Zinssatz muss zwischen 0 und 100 liegen" }]
      data.interestRate = rate
      audit(data, "Zinssatz geändert", currentUser.name, "System", `Neuer Zinssatz: ${rate}%`)
    }
    saveData(data)
    return [200, { ok: true }]
  }

  return [404, { error: "Nicht gefunden" }]
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

function createServer({ dataDir } = {}) {
  DATA_FILE = path.join(dataDir || __dirname, "data.json")
  const dir = path.dirname(DATA_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const data = migrateUsers(loadData())
  seedData(data)

  return http.createServer((req, res) => {
    const sendJSON = (code, data) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      })
      res.end(JSON.stringify(data))
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      })
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)

    // API routes
    if (url.pathname.startsWith("/api/")) {
      let body = ""
      req.on("data", chunk => body += chunk)
      req.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {}
          parsed._auth = req.headers.authorization ?? ""
          const [code, resp] = handleAPI(req.method, url.pathname, parsed, data)
          sendJSON(code, resp)
        } catch (e) {
          sendJSON(400, { error: "Ungültige Anfrage" })
        }
      })
      return
    }

    // Static files
    let filePath = url.pathname === "/" ? "/download.html" : url.pathname === "/app" ? "/banking.html" : decodeURI(url.pathname)
    if (filePath === "/banking.html" && url.pathname !== "/app") {
      res.writeHead(302, { Location: "/" })
      res.end()
      return
    }
    filePath = path.join(DIR, filePath)

    // Security: prevent directory traversal
    if (!filePath.startsWith(DIR)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end("Not found")
        return
      }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      })
      res.end(data)
    })
  })
}

// Run standalone (not Electron)
if (require.main === module) {
  const PORT = parseInt(process.env.PORT) || 8080
  const server = createServer()
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server läuft auf http://localhost:${PORT}`)
  })
}

module.exports = { createServer }
