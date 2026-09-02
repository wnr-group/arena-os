/**
 * Video sections embed YouTube only (M13 v1 scope) — never a raw uploaded
 * file, never an arbitrary iframe src. Every accepted URL is reduced to a
 * bare 11-character video id; the renderer rebuilds the embed src from that
 * id alone, so nothing from the pasted URL's query string ever reaches the
 * page.
 */
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

export function extractYoutubeVideoId(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase()

  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.slice(1)
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v')
    } else if (url.pathname.startsWith('/embed/')) {
      id = url.pathname.slice('/embed/'.length)
    } else if (url.pathname.startsWith('/shorts/')) {
      id = url.pathname.slice('/shorts/'.length)
    }
  }

  if (!id || !VIDEO_ID_PATTERN.test(id)) return null
  return id
}

export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`
}
