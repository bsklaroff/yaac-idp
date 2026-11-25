/**
 * The issuer's tables. better-auth and its plugins define them (they are the
 * models its adapter reads and writes), so a column here exists because
 * better-auth names it; `schema.test.ts` fails when the two disagree.
 *
 * `snakeCase.table` derives each column's name from its camelCase key
 * (`createdAt` becomes `created_at`). A table is its model's name in the
 * plural, which is how the adapter looks it up (`usePlural`).
 *
 * drizzle-kit loads this file with plain-Node resolution, so keep it free of
 * `#` imports.
 */
import { boolean, index, integer, jsonb, snakeCase, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const users = snakeCase.table('users', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().default(false).notNull(),
  image: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
})

export const sessions = snakeCase.table('sessions', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  token: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).$onUpdate(() => new Date()).notNull(),
  ipAddress: text(),
  userAgent: text(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [index().on(t.userId)])

export const accounts = snakeCase.table('accounts', {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp({ withTimezone: true }),
  refreshTokenExpiresAt: timestamp({ withTimezone: true }),
  scope: text(),
  password: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).$onUpdate(() => new Date()).notNull(),
}, (t) => [index().on(t.userId)])

export const verifications = snakeCase.table('verifications', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index().on(t.identifier)])

export const jwks = snakeCase.table('jwks', {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  expiresAt: timestamp({ withTimezone: true }),
  alg: text(),
  crv: text(),
})

export const oauthClients = snakeCase.table('oauth_clients', {
  id: text().primaryKey(),
  clientId: text().notNull().unique(),
  clientSecret: text(),
  clientDiscoveryId: text(),
  disabled: boolean().default(false),
  skipConsent: boolean(),
  enableEndSession: boolean(),
  subjectType: text(),
  scopes: text().array(),
  clientCredentialsScopes: text().array().default([]),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }),
  name: text(),
  uri: text(),
  icon: text(),
  contacts: text().array(),
  tos: text(),
  policy: text(),
  softwareId: text(),
  softwareVersion: text(),
  softwareStatement: text(),
  redirectUris: text().array().notNull(),
  postLogoutRedirectUris: text().array(),
  backchannelLogoutUri: text(),
  backchannelLogoutSessionRequired: boolean(),
  tokenEndpointAuthMethod: text(),
  applicationType: text(),
  jwks: text(),
  jwksUri: text(),
  grantTypes: text().array(),
  responseTypes: text().array(),
  requirePKCE: boolean(),
  dpopBoundAccessTokens: boolean().default(false),
  referenceId: text(),
  metadata: jsonb(),
}, (t) => [index().on(t.userId)])

export const oauthResources = snakeCase.table('oauth_resources', {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text().array(),
  customClaims: jsonb(),
  dpopBoundAccessTokensRequired: boolean().default(false),
  disabled: boolean().default(false),
  createdAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }),
  policyVersion: integer().default(1),
  metadata: jsonb(),
})

export const oauthClientResources = snakeCase.table('oauth_client_resources', {
  id: text().primaryKey(),
  clientId: text().notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  resourceId: text().notNull().references(() => oauthResources.identifier, { onDelete: 'cascade' }),
  metadata: jsonb(),
  createdAt: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex().on(t.clientId, t.resourceId), index().on(t.clientId), index().on(t.resourceId)])

export const oauthRefreshTokens = snakeCase.table('oauth_refresh_tokens', {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  clientId: text().notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  sessionId: text().references(() => sessions.id, {
    onDelete: 'set null',
  }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text(),
  authorizationCodeId: text(),
  resources: text().array(),
  requestedUserInfoClaims: text().array(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  revoked: timestamp({ withTimezone: true }),
  rotatedAt: timestamp({ withTimezone: true }),
  rotationReplayResponse: text(),
  rotationReplayExpiresAt: timestamp({ withTimezone: true }),
  authTime: timestamp({ withTimezone: true }),
  confirmation: jsonb(),
  scopes: text().array().notNull(),
}, (t) => [index().on(t.clientId), index().on(t.sessionId), index().on(t.userId), index().on(t.authorizationCodeId)])

export const oauthAccessTokens = snakeCase.table('oauth_access_tokens', {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  clientId: text().notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  sessionId: text().references(() => sessions.id, {
    onDelete: 'set null',
  }),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text(),
  authorizationCodeId: text(),
  resources: text().array(),
  requestedUserInfoClaims: text().array(),
  refreshId: text().references(() => oauthRefreshTokens.id, {
    onDelete: 'cascade',
  }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  revoked: timestamp({ withTimezone: true }),
  confirmation: jsonb(),
  scopes: text().array().notNull(),
}, (t) => [index().on(t.clientId), index().on(t.sessionId), index().on(t.userId), index().on(t.authorizationCodeId), index().on(t.refreshId)])

export const oauthConsents = snakeCase.table('oauth_consents', {
  id: text().primaryKey(),
  clientId: text().notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  userId: text().references(() => users.id, { onDelete: 'cascade' }),
  referenceId: text(),
  resources: text().array(),
  requestedUserInfoClaims: text().array(),
  scopes: text().array().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
}, (t) => [index().on(t.clientId), index().on(t.userId)])

export const oauthClientAssertions = snakeCase.table('oauth_client_assertions', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
})
