import crypto from 'node:crypto';
import {
  BlobSASPermissions,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { getPool, sql } from '../db';

type TenantBrandingAssetKind = 'logo' | 'logo_dark' | 'hero';

interface TenantRow {
  tenant_id: string;
  slug: string;
}

interface TenantBrandingRow {
  tenant_id: string;
  org_long_name: string | null;
  org_short_name: string | null;
  support_email: string | null;
  accessibility_email: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  hero_image_urls: string | null;
  primary_color: string | null;
  accent_color: string | null;
  dark_color: string | null;
  program_tagline: string | null;
  portal_login_url: string | null;
  mission_blurb: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantBranding {
  tenant_id: string;
  org_long_name: string | null;
  org_short_name: string | null;
  support_email: string | null;
  accessibility_email: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  hero_image_urls: string[];
  primary_color: string | null;
  accent_color: string | null;
  dark_color: string | null;
  program_tagline: string | null;
  portal_login_url: string | null;
  mission_blurb: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateBrandingAssetUploadUrlInput {
  tenantId: string;
  fileName: string;
  contentType: string;
  assetKind: TenantBrandingAssetKind;
}

interface CreateBrandingAssetUploadUrlResult {
  upload_url: string;
  blob_url: string;
  blob_path: string;
  expires_at: string;
  required_headers: Record<string, string>;
}

interface UpsertTenantBrandingInput {
  tenantId: string;
  org_long_name?: string | null;
  org_short_name?: string | null;
  support_email?: string | null;
  accessibility_email?: string | null;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  hero_image_urls?: string[];
  primary_color?: string | null;
  accent_color?: string | null;
  dark_color?: string | null;
  program_tagline?: string | null;
  portal_login_url?: string | null;
  mission_blurb?: string | null;
}

interface CommitBrandingAssetInput {
  tenantId: string;
  assetKind: TenantBrandingAssetKind;
  assetUrl: string;
}

interface BlobConfig {
  accountName: string;
  accountKey: string;
  containerName: string;
  baseUrl: string;
}

const BLOB_CONNECTION_STRING = process.env['TENANT_BRANDING_BLOB_CONNECTION_STRING']?.trim() ?? '';
const BLOB_ACCOUNT_NAME = process.env['TENANT_BRANDING_BLOB_ACCOUNT_NAME']?.trim() ?? '';
const BLOB_ACCOUNT_KEY = process.env['TENANT_BRANDING_BLOB_ACCOUNT_KEY']?.trim() ?? '';
const BLOB_CONTAINER_NAME = process.env['TENANT_BRANDING_BLOB_CONTAINER']?.trim() || 'tenant-branding';
const BLOB_PUBLIC_BASE_URL = process.env['TENANT_BRANDING_BLOB_PUBLIC_BASE_URL']?.trim() ?? '';
const DEFAULT_TENANT_ID = (process.env['DEFAULT_TENANT_ID'] ?? '1b6b9719-663a-4e56-8f7d-9a4bd4c10001').trim().toLowerCase();

function asIsoString(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseHeroImageUrls(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeOptional(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeFileName(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
  return safe.length > 0 ? safe.slice(0, 120) : 'asset';
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

function isAllowedImageContentType(value: string): boolean {
  return [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/avif',
  ].includes(value);
}

function resolveBlobConfig(): BlobConfig {
  const accountNameFromConnection = /AccountName=([^;]+)/i.exec(BLOB_CONNECTION_STRING)?.[1]?.trim() ?? '';
  const accountKeyFromConnection = /AccountKey=([^;]+)/i.exec(BLOB_CONNECTION_STRING)?.[1]?.trim() ?? '';

  const accountName = BLOB_ACCOUNT_NAME || accountNameFromConnection;
  const accountKey = BLOB_ACCOUNT_KEY || accountKeyFromConnection;

  if (!accountName || !accountKey) {
    throw new Error('Blob storage credentials are not configured. Set TENANT_BRANDING_BLOB_CONNECTION_STRING or TENANT_BRANDING_BLOB_ACCOUNT_NAME and TENANT_BRANDING_BLOB_ACCOUNT_KEY.');
  }

  const baseUrl = BLOB_PUBLIC_BASE_URL || `https://${accountName}.blob.core.windows.net`;
  return {
    accountName,
    accountKey,
    containerName: BLOB_CONTAINER_NAME,
    baseUrl: baseUrl.replace(/\/+$/, ''),
  };
}

async function getTenantById(tenantId: string): Promise<TenantRow | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<TenantRow>(
      `SELECT TOP (1) tenant_id, slug
       FROM dbo.tenant
       WHERE tenant_id = @tenant_id`
    );

  return result.recordset[0] ?? null;
}

function toTenantBranding(row: TenantBrandingRow): TenantBranding {
  return {
    tenant_id: row.tenant_id,
    org_long_name: row.org_long_name,
    org_short_name: row.org_short_name,
    support_email: row.support_email,
    accessibility_email: row.accessibility_email,
    logo_url: row.logo_url,
    logo_dark_url: row.logo_dark_url,
    hero_image_urls: parseHeroImageUrls(row.hero_image_urls),
    primary_color: row.primary_color,
    accent_color: row.accent_color,
    dark_color: row.dark_color,
    program_tagline: row.program_tagline,
    portal_login_url: row.portal_login_url,
    mission_blurb: row.mission_blurb,
    created_at: asIsoString(row.created_at),
    updated_at: asIsoString(row.updated_at),
  };
}

function mergeBrandingWithDefaults(primary: TenantBrandingRow, fallback: TenantBrandingRow | null): TenantBrandingRow {
  if (!fallback || primary.tenant_id.toLowerCase() === fallback.tenant_id.toLowerCase()) {
    return primary;
  }

  const primaryHeroImages = parseHeroImageUrls(primary.hero_image_urls);
  const fallbackHeroImages = parseHeroImageUrls(fallback.hero_image_urls);

  return {
    ...primary,
    org_long_name: primary.org_long_name ?? fallback.org_long_name,
    org_short_name: primary.org_short_name ?? fallback.org_short_name,
    support_email: primary.support_email ?? fallback.support_email,
    accessibility_email: primary.accessibility_email ?? fallback.accessibility_email,
    logo_url: primary.logo_url ?? fallback.logo_url,
    logo_dark_url: primary.logo_dark_url ?? fallback.logo_dark_url,
    hero_image_urls: primaryHeroImages.length > 0
      ? primary.hero_image_urls
      : (fallbackHeroImages.length > 0 ? fallback.hero_image_urls : primary.hero_image_urls),
    primary_color: primary.primary_color ?? fallback.primary_color,
    accent_color: primary.accent_color ?? fallback.accent_color,
    dark_color: primary.dark_color ?? fallback.dark_color,
    program_tagline: primary.program_tagline ?? fallback.program_tagline,
    portal_login_url: primary.portal_login_url ?? fallback.portal_login_url,
    mission_blurb: primary.mission_blurb ?? fallback.mission_blurb,
  };
}

async function getTenantBranding(tenantId: string): Promise<TenantBranding | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('default_tenant_id', sql.UniqueIdentifier, DEFAULT_TENANT_ID)
    .query<TenantBrandingRow>(
      `SELECT
          tenant_id,
          org_long_name,
          org_short_name,
          support_email,
          accessibility_email,
          logo_url,
          logo_dark_url,
          hero_image_urls,
          primary_color,
          accent_color,
          dark_color,
          program_tagline,
          portal_login_url,
          mission_blurb,
          created_at,
          updated_at
       FROM dbo.tenant_branding
       WHERE tenant_id IN (@tenant_id, @default_tenant_id)`
    );

  const tenantRow = result.recordset.find((row) => row.tenant_id.toLowerCase() === tenantId.toLowerCase()) ?? null;
  if (!tenantRow) {
    return null;
  }
  const fallbackRow = result.recordset.find((row) => row.tenant_id.toLowerCase() === DEFAULT_TENANT_ID) ?? null;
  return toTenantBranding(mergeBrandingWithDefaults(tenantRow, fallbackRow));
}

async function upsertTenantBranding(input: UpsertTenantBrandingInput): Promise<TenantBranding> {
  const tenant = await getTenantById(input.tenantId);
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, input.tenantId)
    .input('org_long_name', sql.NVarChar(255), normalizeOptional(input.org_long_name))
    .input('org_short_name', sql.NVarChar(120), normalizeOptional(input.org_short_name))
    .input('support_email', sql.NVarChar(255), normalizeOptional(input.support_email))
    .input('accessibility_email', sql.NVarChar(255), normalizeOptional(input.accessibility_email))
    .input('logo_url', sql.NVarChar(1024), normalizeOptional(input.logo_url))
    .input('logo_dark_url', sql.NVarChar(1024), normalizeOptional(input.logo_dark_url))
    .input('hero_image_urls', sql.NVarChar(sql.MAX), input.hero_image_urls ? JSON.stringify(input.hero_image_urls) : null)
    .input('primary_color', sql.NVarChar(20), normalizeOptional(input.primary_color))
    .input('accent_color', sql.NVarChar(20), normalizeOptional(input.accent_color))
    .input('dark_color', sql.NVarChar(20), normalizeOptional(input.dark_color))
    .input('program_tagline', sql.NVarChar(300), normalizeOptional(input.program_tagline))
    .input('portal_login_url', sql.NVarChar(1024), normalizeOptional(input.portal_login_url))
    .input('mission_blurb', sql.NVarChar(sql.MAX), normalizeOptional(input.mission_blurb))
    .query<TenantBrandingRow>(
      `MERGE dbo.tenant_branding AS target
       USING (SELECT @tenant_id AS tenant_id) AS source
          ON target.tenant_id = source.tenant_id
       WHEN MATCHED THEN
          UPDATE SET
            org_long_name = COALESCE(@org_long_name, target.org_long_name),
            org_short_name = COALESCE(@org_short_name, target.org_short_name),
            support_email = COALESCE(@support_email, target.support_email),
            accessibility_email = COALESCE(@accessibility_email, target.accessibility_email),
            logo_url = COALESCE(@logo_url, target.logo_url),
            logo_dark_url = COALESCE(@logo_dark_url, target.logo_dark_url),
            hero_image_urls = COALESCE(@hero_image_urls, target.hero_image_urls),
            primary_color = COALESCE(@primary_color, target.primary_color),
            accent_color = COALESCE(@accent_color, target.accent_color),
            dark_color = COALESCE(@dark_color, target.dark_color),
            program_tagline = COALESCE(@program_tagline, target.program_tagline),
            portal_login_url = COALESCE(@portal_login_url, target.portal_login_url),
            mission_blurb = COALESCE(@mission_blurb, target.mission_blurb),
            updated_at = GETUTCDATE()
       WHEN NOT MATCHED THEN
          INSERT (
            tenant_id,
            org_long_name,
            org_short_name,
            support_email,
            accessibility_email,
            logo_url,
            logo_dark_url,
            hero_image_urls,
            primary_color,
            accent_color,
            dark_color,
            program_tagline,
            portal_login_url,
            mission_blurb,
            created_at,
            updated_at
          )
          VALUES (
            @tenant_id,
            @org_long_name,
            @org_short_name,
            @support_email,
            @accessibility_email,
            @logo_url,
            @logo_dark_url,
            COALESCE(@hero_image_urls, N'[]'),
            @primary_color,
            @accent_color,
            @dark_color,
            @program_tagline,
            @portal_login_url,
            @mission_blurb,
            GETUTCDATE(),
            GETUTCDATE()
          )
       OUTPUT
          inserted.tenant_id,
          inserted.org_long_name,
          inserted.org_short_name,
          inserted.support_email,
          inserted.accessibility_email,
          inserted.logo_url,
          inserted.logo_dark_url,
          inserted.hero_image_urls,
          inserted.primary_color,
          inserted.accent_color,
          inserted.dark_color,
          inserted.program_tagline,
          inserted.portal_login_url,
          inserted.mission_blurb,
          inserted.created_at,
          inserted.updated_at;`
    );

  const row = result.recordset[0];
  if (!row) {
    throw new Error('Failed to persist tenant branding');
  }
  return toTenantBranding(row);
}

async function createBrandingAssetUploadUrl(input: CreateBrandingAssetUploadUrlInput): Promise<CreateBrandingAssetUploadUrlResult> {
  const tenant = await getTenantById(input.tenantId);
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const normalizedContentType = normalizeContentType(input.contentType);
  if (!isAllowedImageContentType(normalizedContentType)) {
    throw new Error('Only image uploads are allowed');
  }

  const fileName = normalizeFileName(input.fileName || 'asset');
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  const pathPrefix = input.assetKind === 'hero' ? 'hero' : 'logo';
  const blobName = `${tenant.slug}/${pathPrefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;

  const config = resolveBlobConfig();

  const sharedKeyCredential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: config.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('cw'),
      startsOn: new Date(Date.now() - 60 * 1000),
      expiresOn: expiresAt,
      protocol: SASProtocol.Https,
      contentType: normalizedContentType,
    },
    sharedKeyCredential
  ).toString();

  const blobUrl = `${config.baseUrl}/${config.containerName}/${blobName}`;
  return {
    upload_url: `${blobUrl}?${sas}`,
    blob_url: blobUrl,
    blob_path: blobName,
    expires_at: expiresAt.toISOString(),
    required_headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': normalizedContentType,
    },
  };
}

async function commitBrandingAsset(input: CommitBrandingAssetInput): Promise<TenantBranding> {
  const existing = await getTenantBranding(input.tenantId);
  const normalizedUrl = normalizeOptional(input.assetUrl);
  if (!normalizedUrl) {
    throw new Error('assetUrl is required');
  }

  const config = resolveBlobConfig();
  const expectedPrefix = `${config.baseUrl}/${config.containerName}/`;
  if (!normalizedUrl.startsWith(expectedPrefix)) {
    throw new Error('assetUrl does not belong to the configured branding blob container');
  }

  if (input.assetKind === 'logo') {
    return upsertTenantBranding({ tenantId: input.tenantId, logo_url: normalizedUrl });
  }
  if (input.assetKind === 'logo_dark') {
    return upsertTenantBranding({ tenantId: input.tenantId, logo_dark_url: normalizedUrl });
  }

  const nextHeroImages = existing?.hero_image_urls ? [...existing.hero_image_urls] : [];
  if (!nextHeroImages.includes(normalizedUrl)) {
    nextHeroImages.push(normalizedUrl);
  }

  return upsertTenantBranding({ tenantId: input.tenantId, hero_image_urls: nextHeroImages });
}

export {
  commitBrandingAsset,
  createBrandingAssetUploadUrl,
  getTenantBranding,
  upsertTenantBranding,
};
export type {
  CreateBrandingAssetUploadUrlResult,
  TenantBranding,
  TenantBrandingAssetKind,
};
