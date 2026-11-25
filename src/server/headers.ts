/**
 * Response headers both listeners send. The pages load only their own
 * scripts and styles (Vite inlines none), and no other site may frame them,
 * so a page cannot be overlaid to trick a click.
 */
import { secureHeaders } from 'hono/secure-headers'

export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ['\'self\''],
    baseUri: ['\'self\''],
    formAction: ['\'self\''],
    frameAncestors: ['\'none\''],
    objectSrc: ['\'none\''],
  },
})
