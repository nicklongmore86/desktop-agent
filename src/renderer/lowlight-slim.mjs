// rehype-highlight imports lowlight's `common` set (37 languages) as its default,
// which would put all of them in the bundle even though Markdown.tsx passes its own
// small list. The production build aliases `lowlight` to this file (see
// electron.vite.config.ts): the same highlighter, with an empty default set.
export { createLowlight } from 'lowlight-lib'
export const common = {}
