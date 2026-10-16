/** The colour-coded file types of the Files tree. Each has a token `--color-ft-<kind>`. */
export const FILE_KINDS = [
  'doc',
  'sheet',
  'slide',
  'pdf',
  'code',
  'image',
  'media',
  'archive',
] as const
export type FileKind = (typeof FILE_KINDS)[number] | 'other'

const EXTENSIONS: Record<Exclude<FileKind, 'other'>, readonly string[]> = {
  doc: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown', 'pages', 'tex'],
  sheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'numbers'],
  slide: ['ppt', 'pptx', 'odp', 'key'],
  pdf: ['pdf'],
  code: [
    'js',
    'jsx',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'json',
    'jsonc',
    'html',
    'htm',
    'css',
    'scss',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'php',
    'swift',
    'sh',
    'ps1',
    'bat',
    'cmd',
    'sql',
    'db',
    'sqlite',
    'xml',
    'yaml',
    'yml',
    'toml',
    'ini',
    'vue',
    'svelte',
    'lua',
    'r',
    'ipynb',
  ],
  image: [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'tif',
    'tiff',
    'heic',
    'avif',
    'psd',
  ],
  media: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab', 'msi'],
}

const BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.map((ext) => [ext, kind as FileKind])),
)

/** Plain-language names, for the accessible description of a row. */
export const FILE_KIND_LABELS: Record<FileKind, string> = {
  doc: 'Document',
  sheet: 'Spreadsheet',
  slide: 'Presentation',
  pdf: 'PDF',
  code: 'Code',
  image: 'Image',
  media: 'Audio or video',
  archive: 'Archive',
  other: 'File',
}

/** A file name's extension, lower case, without the dot ('' for none or a dotfile). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The colour-coded type of a file, from its extension. Pure; also used by the Git panel. */
export function fileKind(name: string): FileKind {
  return BY_EXTENSION.get(extensionOf(name)) ?? 'other'
}
