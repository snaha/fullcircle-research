// Feed topic constants shared between the uploader (Node) and the explorer
// (browser). Kept in its own file so the browser-side consumer doesn't pull
// in Node-only dependencies (fs, path) from feed-publisher.ts.

import { Topic } from '@ethersphere/bee-js'

export type FeedKind = 'manifest' | 'pot' | 'sqlite' | 'app'

export const FEED_TOPIC_STRINGS: Record<FeedKind, string> = {
  manifest: 'fullcircle.manifest.v1',
  pot: 'fullcircle.pot.v1',
  sqlite: 'fullcircle.sqlite.v1',
  app: 'fullcircle.app.v1',
}

export const FEED_TOPICS: Record<FeedKind, Topic> = {
  manifest: Topic.fromString(FEED_TOPIC_STRINGS.manifest),
  pot: Topic.fromString(FEED_TOPIC_STRINGS.pot),
  sqlite: Topic.fromString(FEED_TOPIC_STRINGS.sqlite),
  app: Topic.fromString(FEED_TOPIC_STRINGS.app),
}
