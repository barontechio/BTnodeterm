export interface DevelopmentPreviewScope { projectId: string; nodeId: string }
export interface DevelopmentPreviewRecord { id: string; label: string }
export interface DevelopmentPreviewApi {
  status(): Promise<{ supported: boolean; reason?: string; storage: 'disabled' }>
  list(scope: DevelopmentPreviewScope): Promise<DevelopmentPreviewRecord[]>
  open(recordId: string): Promise<string>
  stop(origin: string): Promise<void>
}
