const { app, BrowserWindow, dialog, shell } = require("electron")
const path = require("path")
const https = require("https")

const PKG = require(path.join(__dirname, "package.json"))
const APP_VERSION = PKG.version
const PUBLIC_URL = PKG.publicUrl

let mainWindow = null

function parseVersion(v) {
  return v.split(".").map(n => parseInt(n) || 0)
}

function isNewer(a, b) {
  const va = parseVersion(a), vb = parseVersion(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    if ((va[i] || 0) > (vb[i] || 0)) return true
    if ((va[i] || 0) < (vb[i] || 0)) return false
  }
  return false
}

async function checkForUpdates() {
  const mod = PUBLIC_URL.startsWith("https") ? https : require("http")
  const remote = await new Promise(resolve => {
    const req = mod.get(`${PUBLIC_URL}/api/version`, res => {
      let body = ""
      res.on("data", c => body += c)
      res.on("end", () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on("error", () => resolve(null))
    req.setTimeout(5000, () => { req.destroy(); resolve(null) })
  })
  return remote
}

async function startApp() {
  const updateInfo = await checkForUpdates()
  if (updateInfo && updateInfo.version && isNewer(updateInfo.version, APP_VERSION)) {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Update verf\u00fcgbar",
      message: `Version ${updateInfo.version} ist verf\u00fcgbar (aktuell: ${APP_VERSION})`,
      detail: "Eine neue Version der Banking-Anwendung ist verf\u00fcgbar. M\u00f6chten Sie die Download-Seite \u00f6ffnen?",
      buttons: ["Jetzt herunterladen", "Sp\u00e4ter"],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) {
      shell.openExternal(`${PUBLIC_URL}${updateInfo.downloadUrl || "/"}`)
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Banking System",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadURL(PUBLIC_URL + "/app?from=desktop")
  mainWindow.on("closed", () => { mainWindow = null })
}

app.whenReady().then(startApp)

app.on("window-all-closed", () => {
  app.quit()
})

app.on("activate", () => {
  if (mainWindow === null) startApp()
})
