import { app, Notification, shell } from 'electron'
import { AppImageUpdater, autoUpdater, DebUpdater, type AppUpdater } from 'electron-updater'
import { debug } from './debug'

/** electron-builder.yml publishes to the same repository. */
const RELEASES_URL = 'https://github.com/whoyoux/quick-ask/releases'
const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Squirrel.Mac only installs an update signed by the same Developer ID as the running app, and
 * our macOS builds aren't signed yet (PLAN T5.5): there we only point to the release page.
 */
const canInstall = process.platform !== 'darwin'

export type UpdateStatus =
  /** A dev build, or Linux outside the AppImage and the .deb package. */
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** macOS only: the user downloads the new version by hand. */
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }

/**
 * Updates from GitHub Releases through electron-updater. Published releases only: the Release
 * workflow's drafts stay invisible until someone publishes them.
 */
export class Updater {
  private status: UpdateStatus = { kind: 'unsupported' }
  private updater: AppUpdater | null = null
  /** The user clicked "Sprawdź aktualizacje": say how it went even when there is nothing new. */
  private manual = false
  /** The last version a macOS notification offered. */
  private announced: string | null = null
  private timers: NodeJS.Timeout[] = []
  /** Held so the click handler isn't garbage collected while the notification is on screen. */
  private notification: Notification | null = null

  constructor(private readonly onChange: () => void) {}

  get current(): UpdateStatus {
    return this.status
  }

  /** Starts the background checks when `automatic`; manual checks work either way. */
  start(automatic: boolean): void {
    // Loading electron-updater's platform updater reads files that only packaged builds have.
    if (!app.isPackaged) return
    // electron-updater picks the .deb updater whenever resources/package-type says "deb", and
    // electron-builder leaves that file behind for every Linux target built after the .deb one.
    const updater = process.platform === 'linux' && process.env.APPIMAGE ? new AppImageUpdater() : autoUpdater
    if (!updater.isUpdaterActive()) return
    this.updater = updater
    updater.logger = { info: debug, warn: console.warn, error: console.error }
    // We start downloads ourselves: on macOS there is nothing we could install.
    updater.autoDownload = false
    // Installing a .deb asks for the admin password; that must not pop up while the app quits.
    updater.autoInstallOnAppQuit = !(updater instanceof DebUpdater)

    updater.on('update-available', (info) => {
      if (!canInstall) {
        this.set({ kind: 'available', version: info.version })
        // Background checks find the same version every few hours; say it once.
        if (this.manual || info.version !== this.announced) {
          this.announced = info.version
          this.notify(`Dostępna jest wersja ${info.version}`, 'Kliknij, aby ją pobrać.', () => this.openRelease())
        }
        this.manual = false
        return
      }
      this.set({ kind: 'downloading', version: info.version, percent: 0 })
      updater.downloadUpdate().catch(() => {
        // Reported through the 'error' event.
      })
    })
    updater.on('update-not-available', () => {
      this.set({ kind: 'idle' })
      if (this.manual) this.notify('Masz najnowszą wersję', `Quick Ask ${app.getVersion()}`)
      this.manual = false
    })
    updater.on('download-progress', (progress) => {
      if (this.status.kind !== 'downloading') return
      // Rebuilding the tray menu closes it on some Linux desktops, so only every 10%.
      const percent = Math.floor(progress.percent / 10) * 10
      if (percent !== this.status.percent) this.set({ ...this.status, percent })
    })
    updater.on('update-downloaded', (info) => {
      this.set({ kind: 'ready', version: info.version })
      this.manual = false
      this.notifyReady(info.version)
    })
    // electron-updater logs the error itself.
    updater.on('error', () => {
      // A failed check or download may leave an earlier update ready to install; keep offering it.
      if (this.status.kind !== 'ready') this.set({ kind: 'idle' })
      if (this.status.kind === 'ready') {
        this.notify('Nie udało się zainstalować aktualizacji', 'Spróbuj ponownie albo pobierz ją ze strony Quick Ask.')
      } else if (this.manual) {
        this.notify('Nie udało się sprawdzić aktualizacji', 'Sprawdź połączenie z internetem i spróbuj ponownie później.')
      }
      this.manual = false
    })

    this.set({ kind: 'idle' })
    this.setAutomatic(automatic)
  }

  setAutomatic(automatic: boolean): void {
    if (!this.updater) return
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (!automatic) return
    this.timers.push(
      setTimeout(() => this.check(false), FIRST_CHECK_DELAY_MS),
      setInterval(() => this.check(false), CHECK_INTERVAL_MS)
    )
  }

  check(manual = true): void {
    if (!this.updater) return
    if (this.status.kind === 'checking' || this.status.kind === 'downloading') return
    // Nothing to look for until the user installs what is already downloaded.
    if (this.status.kind === 'ready') {
      if (manual) this.notifyReady(this.status.version)
      return
    }
    this.manual = manual
    this.set({ kind: 'checking' })
    this.updater.checkForUpdates().catch(() => {
      // Reported through the 'error' event.
    })
  }

  /** Quits, installs the downloaded version and starts it again. */
  install(): void {
    if (this.status.kind !== 'ready') return
    // Silent: the one-click NSIS installer would otherwise show its progress window.
    this.updater?.quitAndInstall(true, true)
  }

  openRelease(): void {
    const url = this.status.kind === 'available' ? `${RELEASES_URL}/tag/v${this.status.version}` : RELEASES_URL
    void shell.openExternal(url)
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.onChange()
  }

  private notifyReady(version: string): void {
    this.notify(
      `Aktualizacja ${version} jest gotowa`,
      this.updater?.autoInstallOnAppQuit
        ? 'Zainstaluje się przy zamknięciu Quick Ask. Kliknij, aby uruchomić ponownie teraz.'
        : 'Kliknij, aby ją zainstalować (system zapyta o hasło).',
      () => this.install()
    )
  }

  private notify(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) return
    this.notification = new Notification({ title, body, silent: true })
    if (onClick) this.notification.on('click', onClick)
    this.notification.show()
  }
}
