// Pages of known text for the Windows OCR tests (ocr-text.test.ts), rendered on the test
// machine with Windows' own System.Drawing (Arial) into raw BGRA pixels, so no image file
// or decoder is involved. Windows only.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OcrImage } from './system-ocr'

const RENDER = `
param([int]$Width, [int]$Height, [double]$FontPx, [double]$Angle, [int]$Ink, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$lines = @($env:OCR_FIXTURE_LINES | ConvertFrom-Json)
$format = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$bmp = New-Object System.Drawing.Bitmap $Width, $Height, $format
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.TranslateTransform($Width / 2, $Height / 2)
$g.RotateTransform($Angle)
$g.TranslateTransform(-$Width / 2, -$Height / 2)
$font = New-Object System.Drawing.Font 'Arial', $FontPx, ([System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $Ink, $Ink, $Ink))
$y = $FontPx * 2
foreach ($line in $lines) {
  $g.DrawString([string]$line, $font, $brush, [single]($FontPx * 2), [single]$y)
  $y += $FontPx * 1.8
}
$g.Dispose()
$rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $format)
if ($data.Stride -ne $Width * 4) { throw "unexpected stride $($data.Stride)" }
$bytes = New-Object byte[] ($data.Stride * $Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
[System.IO.File]::WriteAllBytes($Out, $bytes)
`

export const KNOWN_LINES = [
  'The quick brown fox jumps over the lazy dog',
  'Invoice number 48213 dated 3 November 2026',
  'Desktop Agent reads text in scanned pages',
  'Total amount due 1284.50 payable within thirty days',
  'Please return the signed contract to the office',
]

export interface PageOptions {
  width: number
  height: number
  lines: readonly string[]
  fontPx: number
  /** Degrees, clockwise. */
  angle?: number
  /** Gray level of the text, 0 black. */
  ink?: number
}

/** A white page with `lines` of Arial, as BGRA pixels. */
export function renderPage(options: PageOptions): OcrImage {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocr-page-'))
  try {
    const script = path.join(dir, 'render.ps1')
    const out = path.join(dir, 'page.bgra')
    writeFileSync(script, RENDER)
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Width',
        String(options.width),
        '-Height',
        String(options.height),
        '-FontPx',
        String(options.fontPx),
        '-Angle',
        String(options.angle ?? 0),
        '-Ink',
        String(options.ink ?? 0),
        '-Out',
        out,
      ],
      {
        env: { ...process.env, OCR_FIXTURE_LINES: JSON.stringify(options.lines) },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    )
    const pixels = new Uint8Array(readFileSync(out))
    return { width: options.width, height: options.height, format: 'bgra8', pixels }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A seeded PRNG, so a degraded page is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A scanned-looking copy: grey paper and lighter ink (low contrast), noise, and speckle,
 * on top of whatever skew the page was rendered with.
 */
export function degrade(page: OcrImage, seed = 7): OcrImage {
  const next = random(seed)
  const pixels = new Uint8Array(page.pixels)
  const step = page.format === 'bgra8' ? 4 : 1
  for (let i = 0; i < pixels.length; i += step) {
    // 0..255 -> 70..215, then +-24 noise, then 0.4% speckle.
    const base = 70 + ((pixels[i] ?? 0) * 145) / 255
    let value = base + (next() - 0.5) * 48
    const roll = next()
    if (roll < 0.002) value = 30
    else if (roll < 0.004) value = 240
    const byte = Math.max(0, Math.min(255, Math.round(value)))
    if (step === 4) {
      pixels[i] = byte
      pixels[i + 1] = byte
      pixels[i + 2] = byte
    } else {
      pixels[i] = byte
    }
  }
  return { ...page, pixels }
}

/** The same page as Gray8. */
export function toGray(page: OcrImage): OcrImage {
  const gray = new Uint8Array(page.width * page.height)
  for (let i = 0; i < gray.length; i++) {
    const b = page.pixels[i * 4] ?? 0
    const g = page.pixels[i * 4 + 1] ?? 0
    const r = page.pixels[i * 4 + 2] ?? 0
    gray[i] = Math.round(0.114 * b + 0.587 * g + 0.299 * r)
  }
  return { width: page.width, height: page.height, format: 'gray8', pixels: gray }
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)

/** The share of `expected`'s words found in `recognized` (each found word used once). */
export function wordRecall(expected: readonly string[], recognized: readonly string[]): number {
  const pool = new Map<string, number>()
  for (const word of words(recognized.join(' '))) pool.set(word, (pool.get(word) ?? 0) + 1)
  const wanted = words(expected.join(' '))
  let hits = 0
  for (const word of wanted) {
    const left = pool.get(word) ?? 0
    if (left > 0) {
      hits++
      pool.set(word, left - 1)
    }
  }
  return wanted.length ? hits / wanted.length : 1
}
