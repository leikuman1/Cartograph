export type AnalysisStatus = "queued" | "running" | "completed" | "failed";

type ProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  repository_url: string;
  created_at: string;
};

type AnalysisRow = {
  id: string;
  organization_id: string;
  project_id: string;
  status: AnalysisStatus;
  is_seed: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

// Only the tables used by the application are exposed through this client type.
export type Database = {
  public: {
    Tables: {
      projects: {
        Row: ProjectRow;
        Insert: Omit<ProjectRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<ProjectRow>;
        Relationships: [];
      };
      analyses: {
        Row: AnalysisRow;
        Insert: Pick<AnalysisRow, "organization_id" | "project_id"> &
          Partial<Omit<AnalysisRow, "organization_id" | "project_id">>;
        Update: Partial<AnalysisRow>;
        Relationships: [{
          foreignKeyName: "analyses_organization_id_project_id_fkey";
          columns: ["organization_id", "project_id"];
          isOneToOne: false;
          referencedRelation: "projects";
          referencedColumns: ["organization_id", "id"];
        }];
      };
    };
    Views: Record<never, never>;
    Functions: {
      ensure_organization: {
        Args: Record<never, never>;
        Returns: undefined;
      };
      sync_organization: {
        Args: { p_organization_id: string; p_deleted: boolean };
        Returns: undefined;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
