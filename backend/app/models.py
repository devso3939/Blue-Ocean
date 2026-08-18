"""Pydantic models shared across the API."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# --- City resolution -------------------------------------------------------
class CityMeta(BaseModel):
    city_id: str
    name: str
    display_name: str
    country: str
    country_code: str
    country_qid: Optional[str] = None
    wikidata_qid: Optional[str] = None
    osm_type: str = "relation"
    osm_id: Optional[int] = None
    center: dict[str, float] = Field(default_factory=dict)   # {lat, lon}
    bbox: dict[str, float] = Field(default_factory=dict)     # {min_lat, min_lon, max_lat, max_lon}
    boundary: Optional[dict[str, Any]] = None                # GeoJSON
    boundary_type: str = "polygon"                           # polygon | bbox
    population: Optional[int] = None
    population_year: Optional[int] = None
    population_source: Optional[str] = None
    population_note: Optional[str] = None
    resolved_at: Optional[str] = None
    nominatim_rank: Optional[int] = None
    nominatim_display: Optional[str] = None
    source: str = "nominatim"


# --- Places / snapshot -----------------------------------------------------
class Place(BaseModel):
    id: str
    name: Optional[str] = None
    lat: float
    lon: float
    primary_category: Optional[str] = None
    category_label: Optional[str] = None
    taxonomy_hierarchy: list[str] = Field(default_factory=list)
    alternate_categories: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    operating_status: Optional[str] = None
    address: Optional[str] = None
    locality: Optional[str] = None
    postcode: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    websites: list[str] = Field(default_factory=list)
    phones: list[str] = Field(default_factory=list)
    emails: list[str] = Field(default_factory=list)
    socials: list[str] = Field(default_factory=list)
    brand: Optional[str] = None
    sources: list[str] = Field(default_factory=list)


class FilterStats(BaseModel):
    in_bbox: int = 0
    in_boundary: int = 0
    removed_closed: int = 0
    removed_no_geometry: int = 0
    removed_duplicates: int = 0
    kept: int = 0


class SnapshotMeta(BaseModel):
    city_id: str
    city_name: str
    country: str
    population: Optional[int] = None
    population_year: Optional[int] = None
    overture_release: str
    fetched_at: str
    bbox: dict[str, float] = Field(default_factory=dict)
    boundary_type: str = "polygon"
    total_places: int = 0
    filter_stats: FilterStats = Field(default_factory=FilterStats)
    source_quality: dict[str, Any] = Field(default_factory=dict)
    primary_counts: dict[str, int] = Field(default_factory=dict)
    matched_counts: dict[str, int] = Field(default_factory=dict)
    leaf_counts: dict[str, int] = Field(default_factory=dict)
    osm_validation: Optional[dict[str, Any]] = None


class CitySnapshot(BaseModel):
    meta: SnapshotMeta
    places: list[Place] = Field(default_factory=list)


# --- Peer analysis ---------------------------------------------------------
class PeerCity(BaseModel):
    city_id: str
    name: str
    country: str
    country_code: str
    population: Optional[int] = None
    population_year: Optional[int] = None
    wikidata_qid: Optional[str] = None
    weight: float = 1.0
    snapshot_ready: bool = False
    total_places: int = 0
    count: int = 0
    per_10k: Optional[float] = None
    boundary_type: str = "polygon"
    note: Optional[str] = None


class CategoryStats(BaseModel):
    category_id: str
    label: str
    family: str
    family_label: str
    count: int = 0
    per_10k: Optional[float] = None
    expected_per_10k: Optional[float] = None
    expected_count: Optional[float] = None
    gap: Optional[float] = None
    gap_pct: Optional[float] = None
    opportunity_score: Optional[int] = None
    score_label: Optional[str] = None
    score_components: dict[str, Any] = Field(default_factory=dict)
    data_confidence: Optional[int] = None
    confidence_components: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    explanation: Optional[str] = None
    ai_insight: Optional[str] = None   # optional LLM summary; deterministic fallback when unset
    name_signal_matches: Optional[int] = None  # places matched purely via learned name signals


class MarketAnalysis(BaseModel):
    analysis_id: str
    city: CityMeta
    category: dict[str, Any] = Field(default_factory=dict)
    snapshot: SnapshotMeta
    peers: list[PeerCity] = Field(default_factory=list)
    peer_selection: dict[str, Any] = Field(default_factory=dict)
    stats: CategoryStats
    places: list[Place] = Field(default_factory=list)
    density_grid: list[dict[str, Any]] = Field(default_factory=list)
    methodology: dict[str, Any] = Field(default_factory=dict)
    generated_at: str = ""
    sparse_coverage: bool = False
    sparse_coverage_detail: Optional[str] = None
    market: Optional[dict[str, Any]] = None   # market context (World Bank + estimates)


class MarketContext(BaseModel):
    country_code: str
    country_name: str
    indicators: dict[str, Any] = Field(default_factory=dict)     # real World Bank values
    buyer_potential: dict[str, Any] = Field(default_factory=dict)  # score + components
    startup_estimate: dict[str, Any] = Field(default_factory=dict)  # costs + payback, labelled estimates
    assumptions: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)


class OpportunityRow(BaseModel):
    category_id: str
    label: str
    family: str
    family_label: str
    existing: int = 0
    per_10k: Optional[float] = None
    expected: Optional[float] = None
    gap: Optional[float] = None
    gap_pct: Optional[float] = None
    score: Optional[int] = None
    score_label: Optional[str] = None
    confidence: Optional[int] = None
    warnings: list[str] = Field(default_factory=list)
    explanation: Optional[str] = None


class OpportunitiesResult(BaseModel):
    city: CityMeta
    snapshot: SnapshotMeta
    peers: list[PeerCity] = Field(default_factory=list)
    opportunities: list[OpportunityRow] = Field(default_factory=list)
    filters_applied: dict[str, Any] = Field(default_factory=dict)
    generated_at: str = ""
    anomaly_warnings: list[str] = Field(default_factory=list)


# --- Jobs ------------------------------------------------------------------
class JobRequest(BaseModel):
    kind: str  # resolve_city | snapshot | analyze | opportunities
    payload: dict[str, Any] = Field(default_factory=dict)


class JobStatus(BaseModel):
    job_id: str
    kind: str
    status: str = "queued"          # queued | running | done | error
    stage: str = "queued"
    progress: float = 0.0           # 0..1
    message: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
