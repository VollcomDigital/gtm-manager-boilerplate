import type { tagmanager_v2 } from "googleapis";

export interface VersionSnapshot {
  environments: tagmanager_v2.Schema$Environment[];
  builtInVariables: tagmanager_v2.Schema$BuiltInVariable[];
  folders: tagmanager_v2.Schema$Folder[];
  clients: tagmanager_v2.Schema$Client[];
  transformations: tagmanager_v2.Schema$Transformation[];
  tags: tagmanager_v2.Schema$Tag[];
  triggers: tagmanager_v2.Schema$Trigger[];
  variables: tagmanager_v2.Schema$Variable[];
  templates: tagmanager_v2.Schema$CustomTemplate[];
  zones: tagmanager_v2.Schema$Zone[];
}

/**
 * Converts a GTM Container Version payload into the same "snapshot shape"
 * consumed by our workspace diff logic.
 */
export function snapshotFromContainerVersion(version: tagmanager_v2.Schema$ContainerVersion): VersionSnapshot {
  return {
    // Environments are container-level metadata, not embedded in container versions.
    environments: [],
    builtInVariables: version.builtInVariable ?? [],
    folders: version.folder ?? [],
    clients: version.client ?? [],
    transformations: version.transformation ?? [],
    tags: version.tag ?? [],
    triggers: version.trigger ?? [],
    variables: version.variable ?? [],
    templates: version.customTemplate ?? [],
    zones: version.zone ?? []
  };
}

