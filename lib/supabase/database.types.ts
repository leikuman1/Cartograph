import type { Framework } from "@/lib/frameworks/taxonomy";
import type { AnalysisStatus, PipelineStage } from "@/lib/pipeline/types";

export type { AnalysisStatus };

type ProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  repository_url: string;
  canonical_repository_url: string;
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
  stage: PipelineStage | null;
  stage_message: string;
  updated_at: string;
  failed_stage: PipelineStage | null;
  commit_sha: string | null;
  run_id: string | null;
  coverage: unknown;
  import_records: unknown;
  schema_version: number | null;
  framework: Framework;
  framework_entries: unknown;
};

type FileRow = {
  id: string;
  organization_id: string;
  analysis_id: string;
  path: string;
  folder: string;
  module: string;
  line_count: number;
  content_hash: string;
  export_names: string[];
  fan_in: number;
  fan_out: number;
  created_at: string;
};

type EdgeRow = {
  id: string;
  organization_id: string;
  analysis_id: string;
  source_file_id: string;
  target_file_id: string;
  kinds: string[];
  created_at: string;
};

type StartAnalysisResult = {
  analysis_id: string;
  run_id: string | null;
  started: boolean;
};

// Only the tables and functions the application calls are exposed through this
// client type. Pipeline writes are service-role RPCs, not table writes.
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
      files: {
        Row: FileRow;
        Insert: Pick<FileRow, "organization_id" | "analysis_id" | "path"> &
          Partial<Omit<FileRow, "organization_id" | "analysis_id" | "path">>;
        Update: Partial<FileRow>;
        Relationships: [];
      };
      edges: {
        Row: EdgeRow;
        Insert: Pick<EdgeRow, "organization_id" | "analysis_id" | "source_file_id" | "target_file_id"> &
          Partial<Omit<EdgeRow, "organization_id" | "analysis_id" | "source_file_id" | "target_file_id">>;
        Update: Partial<EdgeRow>;
        Relationships: [];
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
      start_analysis: {
        Args: { p_repository_url: string; p_name: string };
        Returns: StartAnalysisResult[];
      };
      rerun_analysis: {
        Args: { p_analysis_id: string };
        Returns: StartAnalysisResult[];
      };
      read_analysis_result: {
        Args: { p_analysis_id: string; p_run_id: string };
        Returns: unknown;
      };
      read_analysis_result_v2: {
        Args: { p_analysis_id: string; p_run_id: string };
        Returns: unknown;
      };
      read_analysis_result_v3: {
        Args: { p_analysis_id: string; p_run_id: string };
        Returns: unknown;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
