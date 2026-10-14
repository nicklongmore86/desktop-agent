import { describe, expect, it } from 'vitest'
import { blocklistReason } from './blocklist'

const blockedWin = (p: string) => blocklistReason(p, 'win32')
const blockedPosix = (p: string) => blocklistReason(p, 'linux')

describe('blocklistReason', () => {
  it.each([
    'C:\\Users\\me\\.ssh',
    'C:\\Users\\me\\.ssh\\config',
    'C:\\Users\\me\\.gnupg\\pubring.kbx',
    'C:\\Users\\me\\.aws\\credentials',
    'C:\\Users\\me\\.azure\\accessTokens.json',
    'C:\\Users\\me\\.kube\\config',
    'C:\\Users\\me\\.docker\\config.json',
    'C:\\proj\\.env',
    'C:\\proj\\.env.local',
    'C:\\proj\\.env.production',
    'C:\\proj\\server.pem',
    'C:\\proj\\tls.key',
    'C:\\proj\\cert.pfx',
    'C:\\proj\\cert.p12',
    'C:\\proj\\id_rsa',
    'C:\\proj\\id_rsa.pub',
    'C:\\proj\\id_ed25519',
    'C:\\proj\\id_ecdsa_sk',
    'C:\\Users\\me\\.npmrc',
    'C:\\Users\\me\\.netrc',
    'C:\\Users\\me\\_netrc',
    'C:\\Users\\me\\.git-credentials',
    'C:\\Users\\me\\Documents\\Passwords.kdbx',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
    'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Default',
    'C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\abc.default\\logins.json',
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\ABCDEF',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Credentials',
    'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-21\\key',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\Vault',
  ])('blocks %s', (p) => {
    expect(blockedWin(p)).not.toBeNull()
  })

  it('is case-insensitive on every platform', () => {
    expect(blockedWin('C:\\Users\\me\\.SSH\\Config')).not.toBeNull()
    expect(blockedWin('C:\\proj\\.ENV')).not.toBeNull()
    expect(blockedWin('C:\\proj\\ID_RSA')).not.toBeNull()
    expect(blockedWin('C:\\proj\\Server.PEM')).not.toBeNull()
    expect(blockedPosix('/home/me/.SSH/id_rsa')).not.toBeNull()
    expect(blockedPosix('/home/me/proj/.Env.Local')).not.toBeNull()
  })

  it('blocks Linux and macOS browser profiles', () => {
    expect(blockedPosix('/home/me/.mozilla/firefox/x.default/key4.db')).not.toBeNull()
    expect(blockedPosix('/home/me/.config/google-chrome/Default/Cookies')).not.toBeNull()
    expect(blockedPosix('/home/me/.config/chromium/Default')).not.toBeNull()
    expect(
      blocklistReason('/Users/me/Library/Application Support/Google/Chrome/Default', 'darwin'),
    ).not.toBeNull()
  })

  it('accepts ordinary files and near-miss names', () => {
    for (const p of [
      'C:\\Users\\me\\Documents\\report.docx',
      'C:\\proj\\environment.ts',
      'C:\\proj\\envfile',
      'C:\\proj\\keyboard.ts',
      'C:\\proj\\monkey.json',
      'C:\\proj\\.sshrc-notes',
      'C:\\proj\\pem\\readme.md',
      'C:\\Users\\me\\.docker\\daemon.json',
      'C:\\Users\\me\\AppData\\Local\\Temp\\x.txt',
      'C:\\Users\\me\\AppData\\Local\\Google\\Drive\\notes.txt',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu',
    ]) {
      expect(blockedWin(p), p).toBeNull()
    }
    expect(blockedPosix('/home/me/projects/app/src/index.ts')).toBeNull()
  })

  it('gives a reason that names the blocked part', () => {
    expect(blockedWin('C:\\Users\\me\\.ssh\\config')).toMatch(/\.ssh.*SSH keys/)
    expect(blockedWin('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data')).toMatch(/Chrome/)
  })
})
