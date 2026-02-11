import { z } from "zod";

/**
 * Minimal GTM API v2 "Parameter" representation.
 *
 * GTM uses nested parameters for LIST/MAP types.
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/tags#Parameter
 */
export interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

export const zGtmParameter: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      type: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      value: z.string().optional(),
      list: z.array(zGtmParameter).optional(),
      map: z.array(zGtmParameter).optional()
    })
    .passthrough()
);

/**
 * Minimal GTM API v2 Tag representation (subset).
 *
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/tags#Tag
 */
export interface GtmTag {
  tagId?: string;
  name: string;
  type: string;
  parameter?: GtmParameter[];
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  [key: string]: unknown;
}

export const zGtmTag = z
  .object({
    tagId: z.string().min(1).optional(),
    name: z.string().min(1),
    type: z.string().min(1),
    parameter: z.array(zGtmParameter).optional(),
    firingTriggerId: z.array(z.string().min(1)).optional(),
    blockingTriggerId: z.array(z.string().min(1)).optional()
  })
  .passthrough();

/**
 * Minimal GTM API v2 Trigger representation (subset).
 *
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/triggers#Trigger
 */
export interface GtmTrigger {
  triggerId?: string;
  name: string;
  type: string;
  filter?: unknown[];
  autoEventFilter?: unknown[];
  customEventFilter?: unknown[];
  [key: string]: unknown;
}

export const zGtmTrigger = z
  .object({
    triggerId: z.string().min(1).optional(),
    name: z.string().min(1),
    type: z.string().min(1),
    filter: z.array(z.unknown()).optional(),
    autoEventFilter: z.array(z.unknown()).optional(),
    customEventFilter: z.array(z.unknown()).optional()
  })
  .passthrough();

/**
 * Minimal GTM API v2 Variable representation (subset).
 *
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/variables#Variable
 */
export interface GtmVariable {
  variableId?: string;
  name: string;
  type: string;
  parameter?: GtmParameter[];
  [key: string]: unknown;
}

export const zGtmVariable = z
  .object({
    variableId: z.string().min(1).optional(),
    name: z.string().min(1),
    type: z.string().min(1),
    parameter: z.array(zGtmParameter).optional()
  })
  .passthrough();

/**
 * Minimal GTM API v2 Custom Template representation (subset).
 *
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/templates#CustomTemplate
 */
export interface GtmCustomTemplate {
  templateId?: string;
  name: string;
  templateData: string;
  [key: string]: unknown;
}

export const zGtmCustomTemplate = z
  .object({
    templateId: z.string().min(1).optional(),
    name: z.string().min(1),
    templateData: z.string().min(1)
  })
  .passthrough();

/**
 * Minimal GTM API v2 Zone representation (subset).
 *
 * Zones are commonly associated with GTM 360 features, but the API surface
 * exists in v2: `/workspaces/zones`.
 *
 * Reference: https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/containers/workspaces/zones
 */
export interface GtmZoneBoundary {
  condition?: unknown[];
  customEvaluationTriggerId?: string[];

  /**
   * IaC-only convenience field; will be resolved to `customEvaluationTriggerId`
   * during sync.
   */
  customEvaluationTriggerNames?: string[];

  [key: string]: unknown;
}

export interface GtmZone {
  zoneId?: string;
  name: string;
  notes?: string;
  boundary?: GtmZoneBoundary;
  childContainer?: unknown[];
  typeRestriction?: unknown;
  [key: string]: unknown;
}

export const zGtmZoneBoundary = z
  .object({
    condition: z.array(z.unknown()).optional(),
    customEvaluationTriggerId: z.array(z.string().min(1)).optional(),
    customEvaluationTriggerNames: z.array(z.string().min(1)).optional()
  })
  .passthrough();

export const zGtmZone = z
  .object({
    zoneId: z.string().min(1).optional(),
    name: z.string().min(1),
    notes: z.string().optional(),
    boundary: zGtmZoneBoundary.optional(),
    childContainer: z.array(z.unknown()).optional(),
    typeRestriction: z.unknown().optional()
  })
  .passthrough();

