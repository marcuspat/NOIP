# Python RAG & Dashboard Implementation Plan
# TDD-Driven Development Strategy

## 🎯 Component Overview

### RAG System (Retrieval-Augmented Generation)
- **Purpose**: Store and query infrastructure knowledge base
- **Technology**: ChromaDB with vector embeddings
- **Input**: JSON inventory files from various tools
- **Output**: Queryable vector database with metadata

### Dashboard Generator
- **Purpose**: Visualize infrastructure metrics and security findings
- **Technology**: Plotly for interactive charts, HTML output
- **Input**: JSON reports from scans and analysis
- **Output**: Interactive HTML dashboard

### Report Generator (Missing Component)
- **Purpose**: Generate executive summaries and detailed reports
- **Technology**: Python templating, markdown generation
- **Input**: Analysis results from multiple sources
- **Output**: Structured reports in multiple formats

## 📋 Current State Analysis

### ✅ Existing Components
1. **update_rag.py** - Basic ChromaDB integration
2. **generate_dashboard.py** - Basic Plotly visualization

### 🔍 Issues Identified
1. **No Error Handling**: Scripts fail silently on missing files
2. **No Configuration**: Hard-coded paths and settings
3. **No Testing**: Zero test coverage
4. **No Dependencies**: Missing requirements.txt
5. **No Logging**: No operational visibility
6. **Missing Features**: Many requirements from NOIPPLAN.md not implemented

## 🧪 TDD Implementation Strategy

### Phase 1: Foundation & Testing Setup (Tasks 100-119)

#### Task 100: Create requirements.txt with Test Dependencies
```python
# requirements.txt
chromadb>=0.4.0
plotly>=5.15.0
pandas>=2.0.0
jinja2>=3.1.0
pydantic>=2.0.0
python-dotenv>=1.0.0

# Test dependencies
pytest>=7.4.0
pytest-cov>=4.1.0
pytest-mock>=3.11.0
pytest-asyncio>=0.21.0
pytest-playwright>=0.3.0

# Development tools
black>=23.0.0
flake8>=6.0.0
mypy>=1.5.0
bandit>=1.7.0
```

#### Task 101: Setup Test Structure and Fixtures
```python
# tests/conftest.py
import pytest
import tempfile
import json
from pathlib import Path

@pytest.fixture
def temp_dir():
    with tempfile.TemporaryDirectory() as tmp_dir:
        yield Path(tmp_dir)

@pytest.fixture
def sample_inventory_data():
    return {
        "kubernetes": {
            "cluster-state.json": {
                "nodes": 3,
                "pods": 15,
                "namespaces": ["default", "production"],
                "timestamp": "2024-01-15T10:30:00Z"
            }
        },
        "network": {
            "topology.json": {
                "devices": 8,
                "connections": 12,
                "vlans": 4
            }
        }
    }

@pytest.fixture
def sample_security_data():
    return {
        "secrets": [
            {"file": "config.py", "type": "aws_key", "severity": "critical"},
            {"file": "env.prod", "type": "database_url", "severity": "high"}
        ],
        "scan_time": "2024-01-15T10:30:00Z",
        "total_issues": 2
    }

@pytest.fixture
def sample_drift_data():
    return {
        "summary": {
            "critical_issues": 1,
            "major_issues": 3,
            "minor_issues": 2,
            "total_resources": 45,
            "drift_percentage": 13.3
        },
        "drifted_resources": [
            {"resource": "security-group-1", "drift_type": "rule_modified"}
        ]
    }
```

#### Task 102: Refactor update_rag.py with Error Handling
```python
# scripts/update_rag.py (Refactored)
import json
import hashlib
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import chromadb
from chromadb.config import Settings
from pydantic import BaseModel, ValidationError

class InventoryData(BaseModel):
    """Pydantic model for inventory data validation"""
    nodes: Optional[int] = None
    pods: Optional[int] = None
    namespaces: Optional[List[str]] = None
    timestamp: Optional[str] = None

class InfrastructureRAG:
    def __init__(self, persist_dir: str = "./rag",
                 collection_name: str = "infrastructure"):
        self.persist_dir = Path(persist_dir)
        self.collection_name = collection_name

        # Setup logging
        self.logger = logging.getLogger(__name__)

        # Initialize ChromaDB
        try:
            self.client = chromadb.Client(Settings(
                chroma_db_impl="duckdb+parquet",
                persist_directory=str(self.persist_dir)
            ))
            self.collection = self.client.get_or_create_collection(
                name=self.collection_name,
                metadata={"hnsw:space": "cosine"}
            )
            self.logger.info(f"RAG system initialized with collection: {self.collection_name}")
        except Exception as e:
            self.logger.error(f"Failed to initialize ChromaDB: {e}")
            raise

    def validate_inventory_data(self, data: Dict) -> bool:
        """Validate inventory data structure"""
        try:
            if isinstance(data, dict):
                # Basic validation - can be extended
                return True
            return False
        except Exception:
            return False

    def update_inventory(self, inventory_path: str) -> Dict[str, int]:
        """Update RAG with latest infrastructure inventory

        Returns:
            Dict with processing statistics
        """
        inventory_path = Path(inventory_path)
        if not inventory_path.exists():
            raise FileNotFoundError(f"Inventory path not found: {inventory_path}")

        stats = {
            "total_files": 0,
            "successful_files": 0,
            "failed_files": 0,
            "errors": []
        }

        for json_file in inventory_path.glob("**/*.json"):
            stats["total_files"] += 1

            try:
                with open(json_file, 'r') as f:
                    data = json.load(f)

                # Validate data
                if not self.validate_inventory_data(data):
                    raise ValueError(f"Invalid data structure in {json_file}")

                # Create document ID from content hash
                doc_id = hashlib.sha256(
                    json.dumps(data, sort_keys=True).encode()
                ).hexdigest()[:16]

                # Prepare metadata
                metadata = {
                    "source": str(json_file.relative_to(inventory_path)),
                    "timestamp": datetime.now().isoformat(),
                    "type": json_file.parent.name,
                    "file_size": json_file.stat().st_size
                }

                # Add to collection
                self.collection.add(
                    documents=[json.dumps(data)],
                    metadatas=[metadata],
                    ids=[doc_id]
                )

                stats["successful_files"] += 1
                self.logger.info(f"Processed: {json_file}")

            except Exception as e:
                error_msg = f"Failed to process {json_file}: {e}"
                stats["errors"].append(error_msg)
                stats["failed_files"] += 1
                self.logger.error(error_msg)

        self.logger.info(f"Inventory update complete: {stats}")
        return stats

    def query_infrastructure(self, query: str, n_results: int = 5,
                           filter_metadata: Optional[Dict] = None) -> Dict:
        """Query infrastructure knowledge base with optional filtering"""
        try:
            kwargs = {"query_texts": [query], "n_results": n_results}
            if filter_metadata:
                kwargs["where"] = filter_metadata

            results = self.collection.query(**kwargs)
            return results
        except Exception as e:
            self.logger.error(f"Query failed: {e}")
            return {"documents": [], "metadatas": [], "distances": []}

def main():
    import sys
    import argparse

    parser = argparse.ArgumentParser(description="Update infrastructure RAG database")
    parser.add_argument("inventory_path", help="Path to inventory directory")
    parser.add_argument("--collection", default="infrastructure",
                       help="Collection name")
    parser.add_argument("--persist-dir", default="./rag",
                       help="RAG persistence directory")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Enable verbose logging")

    args = parser.parse_args()

    # Setup logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format='%(asctime)s - %(levelname)s - %(message)s')

    try:
        rag = InfrastructureRAG(
            persist_dir=args.persist_dir,
            collection_name=args.collection
        )
        stats = rag.update_inventory(args.inventory_path)

        print(f"✅ RAG database updated successfully")
        print(f"   Files processed: {stats['total_files']}")
        print(f"   Successful: {stats['successful_files']}")
        print(f"   Failed: {stats['failed_files']}")

        if stats['errors']:
            print(f"   Errors: {len(stats['errors'])}")
            for error in stats['errors'][:3]:  # Show first 3 errors
                print(f"     - {error}")

    except Exception as e:
        print(f"❌ Failed to update RAG database: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
```

#### Task 103: Write Unit Tests for update_rag.py
```python
# tests/test_update_rag.py
import pytest
import json
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
from scripts.update_rag import InfrastructureRAG

class TestInfrastructureRAG:
    def test_init_creates_directory(self, temp_dir):
        """Test that initialization creates persist directory"""
        rag = InfrastructureRAG(persist_dir=str(temp_dir))
        assert temp_dir.exists()
        assert rag.collection_name == "infrastructure"

    def test_init_with_custom_collection_name(self, temp_dir):
        """Test initialization with custom collection name"""
        rag = InfrastructureRAG(
            persist_dir=str(temp_dir),
            collection_name="test_collection"
        )
        assert rag.collection_name == "test_collection"

    def test_update_inventory_with_nonexistent_path(self, temp_dir):
        """Test error handling for nonexistent inventory path"""
        rag = InfrastructureRAG(persist_dir=str(temp_dir))

        with pytest.raises(FileNotFoundError):
            rag.update_inventory("/nonexistent/path")

    def test_update_inventory_with_valid_data(self, temp_dir, sample_inventory_data):
        """Test successful inventory update"""
        # Create test inventory files
        inventory_dir = temp_dir / "inventory"
        inventory_dir.mkdir()

        for filename, data in sample_inventory_data.items():
            (inventory_dir / filename).write_text(json.dumps(data))

        rag = InfrastructureRAG(persist_dir=str(temp_dir))
        stats = rag.update_inventory(str(inventory_dir))

        assert stats["total_files"] == 2
        assert stats["successful_files"] == 2
        assert stats["failed_files"] == 0
        assert len(stats["errors"]) == 0

    def test_update_inventory_with_invalid_json(self, temp_dir):
        """Test handling of invalid JSON files"""
        inventory_dir = temp_dir / "inventory"
        inventory_dir.mkdir()

        # Create invalid JSON file
        invalid_file = inventory_dir / "invalid.json"
        invalid_file.write_text("{ invalid json content")

        rag = InfrastructureRAG(persist_dir=str(temp_dir))
        stats = rag.update_inventory(str(inventory_dir))

        assert stats["total_files"] == 1
        assert stats["successful_files"] == 0
        assert stats["failed_files"] == 1
        assert len(stats["errors"]) == 1

    def test_query_infrastructure(self, temp_dir, sample_inventory_data):
        """Test infrastructure querying"""
        # Setup test data
        inventory_dir = temp_dir / "inventory"
        inventory_dir.mkdir()

        test_file = inventory_dir / "test.json"
        test_file.write_text(json.dumps(sample_inventory_data["kubernetes"]))

        rag = InfrastructureRAG(persist_dir=str(temp_dir))
        rag.update_inventory(str(inventory_dir))

        # Test query
        results = rag.query_infrastructure("kubernetes nodes")
        assert len(results["documents"]) > 0
        assert len(results["metadatas"]) > 0

    def test_query_with_metadata_filter(self, temp_dir, sample_inventory_data):
        """Test querying with metadata filtering"""
        # Setup test data
        inventory_dir = temp_dir / "inventory"
        inventory_dir.mkdir()

        test_file = inventory_dir / "kubernetes" / "test.json"
        test_file.parent.mkdir()
        test_file.write_text(json.dumps(sample_inventory_data["kubernetes"]))

        rag = InfrastructureRAG(persist_dir=str(temp_dir))
        rag.update_inventory(str(inventory_dir))

        # Test query with filter
        results = rag.query_infrastructure(
            "nodes",
            filter_metadata={"type": "kubernetes"}
        )
        assert len(results["documents"]) > 0
        assert results["metadatas"][0][0]["type"] == "kubernetes"

    @patch('scripts.update_rag.chromadb.Client')
    def test_chromadb_initialization_failure(self, mock_client, temp_dir):
        """Test handling of ChromaDB initialization failure"""
        mock_client.side_effect = Exception("Failed to connect")

        with pytest.raises(Exception) as exc_info:
            InfrastructureRAG(persist_dir=str(temp_dir))

        assert "Failed to initialize ChromaDB" in str(exc_info.value)

class TestMainFunction:
    def test_main_with_valid_arguments(self, temp_dir, sample_inventory_data, capsys):
        """Test main function with valid arguments"""
        # Create test inventory
        inventory_dir = temp_dir / "inventory"
        inventory_dir.mkdir()

        test_file = inventory_dir / "test.json"
        test_file.write_text(json.dumps(sample_inventory_data["kubernetes"]))

        # Mock sys.argv
        test_args = [
            "update_rag.py",
            str(inventory_dir),
            "--persist-dir", str(temp_dir),
            "--verbose"
        ]

        with patch('sys.argv', test_args):
            from scripts.update_rag import main
            main()

        captured = capsys.readouterr()
        assert "✅ RAG database updated successfully" in captured.out
        assert "Files processed: 1" in captured.out

    def test_main_with_invalid_path(self, capsys):
        """Test main function with invalid path"""
        test_args = ["update_rag.py", "/nonexistent/path"]

        with patch('sys.argv', test_args):
            from scripts.update_rag import main
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
```

#### Task 104: Enhanced Dashboard Generator with Error Handling
```python
# scripts/generate_dashboard.py (Enhanced)
import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import pandas as pd
from pydantic import BaseModel, ValidationError

class SecurityData(BaseModel):
    """Model for security scan data"""
    secrets: List[Dict[str, Any]] = []
    scan_time: Optional[str] = None
    total_issues: int = 0

class DriftData(BaseModel):
    """Model for drift detection data"""
    summary: Dict[str, Any] = {}
    drifted_resources: List[Dict[str, Any]] = []

class NetworkData(BaseModel):
    """Model for network topology data"""
    nodes: Optional[int] = None
    pods: Optional[int] = None
    namespaces: Optional[List[str]] = None

class DashboardGenerator:
    def __init__(self, reports_dir: str, output_dir: Optional[str] = None):
        self.reports_dir = Path(reports_dir)
        self.output_dir = Path(output_dir) if output_dir else self.reports_dir
        self.logger = logging.getLogger(__name__)

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Load data with error handling
        self.drift_data = self.load_json("drift-report.json", DriftData)
        self.security_data = self.load_json("security-scan.json", SecurityData)
        self.network_data = self.load_json("cluster-state.json", NetworkData)

    def load_json(self, filename: str, model_class: type) -> Any:
        """Load and validate JSON data using Pydantic model"""
        filepath = self.reports_dir / filename
        if not filepath.exists():
            self.logger.warning(f"File not found: {filepath}")
            return model_class()

        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
            return model_class(**data)
        except json.JSONDecodeError as e:
            self.logger.error(f"Invalid JSON in {filename}: {e}")
            return model_class()
        except ValidationError as e:
            self.logger.error(f"Validation error in {filename}: {e}")
            return model_class()
        except Exception as e:
            self.logger.error(f"Unexpected error loading {filename}: {e}")
            return model_class()

    def create_security_chart(self) -> Optional[go.Bar]:
        """Create security issues chart"""
        if not self.security_data.secrets:
            return None

        severities = {}
        for issue in self.security_data.secrets:
            sev = issue.get("severity", "unknown").lower()
            severities[sev] = severities.get(sev, 0) + 1

        return go.Bar(
            x=list(severities.keys()),
            y=list(severities.values()),
            name="Security Issues",
            marker_color=['red', 'orange', 'yellow', 'blue'][:len(severities)]
        )

    def create_drift_chart(self) -> Optional[go.Pie]:
        """Create configuration drift chart"""
        if not self.drift_data.summary:
            return None

        summary = self.drift_data.summary
        values = [
            summary.get("critical_issues", 0),
            summary.get("major_issues", 0),
            summary.get("minor_issues", 0)
        ]

        # Only show chart if there are issues
        if sum(values) == 0:
            return None

        return go.Pie(
            labels=["Critical", "Major", "Minor"],
            values=values,
            name="Configuration Drift",
            marker_colors=["red", "orange", "yellow"]
        )

    def create_network_chart(self) -> Optional[go.Indicator]:
        """Create network health indicator"""
        if not self.network_data or not hasattr(self.network_data, 'nodes'):
            return None

        # Simple health calculation based on nodes and pods
        nodes = self.network_data.nodes or 0
        pods = self.network_data.pods or 0

        if nodes == 0:
            return None

        # Health score (0-100) based on pod density
        health_score = max(0, min(100, 100 - (pods / nodes * 10)))

        return go.Indicator(
            mode="gauge+number+delta",
            value=health_score,
            domain={'x': [0, 1], 'y': [0, 1]},
            title={'text': "Network Health Score"},
            delta={'reference': 80},
            gauge={
                'axis': {'range': [None, 100]},
                'bar': {'color': "darkblue"},
                'steps': [
                    {'range': [0, 50], 'color': "lightgray"},
                    {'range': [50, 80], 'color': "gray"},
                    {'range': [80, 100], 'color': "lightgreen"}
                ],
                'threshold': {
                    'line': {'color': "red", 'width': 4},
                    'thickness': 0.75,
                    'value': 90
                }
            }
        )

    def create_resource_chart(self) -> Optional[go.Scatter]:
        """Create resource utilization chart"""
        if not self.network_data:
            return None

        # Mock historical data for demonstration
        hours = list(range(24))
        cpu_usage = [30 + i * 2 + (i % 5) * 5 for i in hours]
        memory_usage = [40 + i * 1.5 + (i % 3) * 8 for i in hours]

        return go.Scatter(
            x=hours,
            y=cpu_usage,
            mode='lines+markers',
            name='CPU Usage %',
            line=dict(color='blue')
        )

    def generate_html_dashboard(self) -> str:
        """Generate comprehensive HTML dashboard"""
        try:
            # Create subplot layout
            fig = make_subplots(
                rows=2, cols=2,
                subplot_titles=(
                    "Security Issues by Severity",
                    "Configuration Drift Status",
                    "Network Health",
                    "Resource Utilization"
                ),
                specs=[
                    [{"type": "bar"}, {"type": "pie"}],
                    [{"type": "indicator"}, {"type": "scatter"}]
                ]
            )

            # Add charts
            security_chart = self.create_security_chart()
            if security_chart:
                fig.add_trace(security_chart, row=1, col=1)

            drift_chart = self.create_drift_chart()
            if drift_chart:
                fig.add_trace(drift_chart, row=1, col=2)

            network_chart = self.create_network_chart()
            if network_chart:
                fig.add_trace(network_chart, row=2, col=1)

            resource_chart = self.create_resource_chart()
            if resource_chart:
                fig.add_trace(resource_chart, row=2, col=2)

            # Update layout
            fig.update_layout(
                title_text="NetOps Intelligence Dashboard",
                showlegend=False,
                height=800,
                template="plotly_white"
            )

            # Generate HTML
            html_content = fig.to_html(include_plotlyjs=True, div_id="dashboard")

            # Add custom styling and metadata
            dashboard_html = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <title>NetOps Intelligence Dashboard</title>
                <style>
                    body {{
                        font-family: Arial, sans-serif;
                        margin: 0;
                        padding: 20px;
                        background-color: #f5f5f5;
                    }}
                    .header {{
                        background-color: #2c3e50;
                        color: white;
                        padding: 20px;
                        border-radius: 8px;
                        margin-bottom: 20px;
                    }}
                    .stats {{
                        display: flex;
                        justify-content: space-around;
                        margin-bottom: 20px;
                    }}
                    .stat-card {{
                        background: white;
                        padding: 15px;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        text-align: center;
                        min-width: 150px;
                    }}
                    .stat-value {{
                        font-size: 24px;
                        font-weight: bold;
                        color: #2c3e50;
                    }}
                    .stat-label {{
                        font-size: 14px;
                        color: #7f8c8d;
                    }}
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>NetOps Intelligence Dashboard</h1>
                    <p>Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
                </div>

                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-value">{self.security_data.total_issues}</div>
                        <div class="stat-label">Security Issues</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">{self.drift_data.summary.get('total_resources', 0)}</div>
                        <div class="stat-label">Total Resources</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">{self.network_data.nodes or 0}</div>
                        <div class="stat-label">Network Nodes</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">{self.drift_data.summary.get('drift_percentage', 0):.1f}%</div>
                        <div class="stat-label">Drift Rate</div>
                    </div>
                </div>

                {html_content}
            </body>
            </html>
            """

            return dashboard_html

        except Exception as e:
            self.logger.error(f"Dashboard generation failed: {e}")
            # Return simple error dashboard
            return f"""
            <!DOCTYPE html>
            <html>
            <head><title>Dashboard Error</title></head>
            <body>
                <h1>Dashboard Generation Error</h1>
                <p>Error: {e}</p>
                <p>Please check the input data and try again.</p>
            </body>
            </html>
            """

    def save_dashboard(self, filename: str = "dashboard.html") -> Path:
        """Save dashboard to file"""
        try:
            dashboard_html = self.generate_html_dashboard()
            output_path = self.output_dir / filename

            with open(output_path, 'w') as f:
                f.write(dashboard_html)

            self.logger.info(f"Dashboard saved to: {output_path}")
            return output_path

        except Exception as e:
            self.logger.error(f"Failed to save dashboard: {e}")
            raise

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Generate NOIP dashboard")
    parser.add_argument("reports_dir", help="Directory containing report JSON files")
    parser.add_argument("--output-dir", help="Output directory for dashboard")
    parser.add_argument("--output-file", default="dashboard.html",
                       help="Dashboard filename")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Enable verbose logging")

    args = parser.parse_args()

    # Setup logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format='%(asctime)s - %(levelname)s - %(message)s')

    try:
        generator = DashboardGenerator(
            reports_dir=args.reports_dir,
            output_dir=args.output_dir
        )

        output_path = generator.save_dashboard(args.output_file)
        print(f"✅ Dashboard generated successfully: {output_path}")

    except Exception as e:
        print(f"❌ Failed to generate dashboard: {e}")
        import sys
        sys.exit(1)

if __name__ == "__main__":
    main()
```

#### Task 105: Implement Missing generate_report.py
```python
# scripts/generate_report.py
import json
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any
from jinja2 import Template, Environment, FileSystemLoader
import pandas as pd
from pydantic import BaseModel, ValidationError
import markdown

class ReportConfig(BaseModel):
    """Configuration for report generation"""
    title: str = "NetOps Intelligence Report"
    format: str = "markdown"  # markdown, html, json
    include_sections: List[str] = ["executive", "security", "drift", "recommendations"]
    template_path: Optional[str] = None

class ReportData:
    """Container for all report data"""
    def __init__(self, reports_dir: str):
        self.reports_dir = Path(reports_dir)
        self.logger = logging.getLogger(__name__)

        # Load all data sources
        self.security_data = self._load_json("security-scan.json")
        self.drift_data = self._load_json("drift-report.json")
        self.network_data = self._load_json("cluster-state.json")
        self.inventory_data = self._load_inventory_data()

        # Generate analysis
        self.analysis = self._generate_analysis()

    def _load_json(self, filename: str) -> Dict[str, Any]:
        """Load JSON data with error handling"""
        filepath = self.reports_dir / filename
        if not filepath.exists():
            self.logger.warning(f"File not found: {filepath}")
            return {}

        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except Exception as e:
            self.logger.error(f"Error loading {filename}: {e}")
            return {}

    def _load_inventory_data(self) -> Dict[str, Any]:
        """Load all inventory JSON files"""
        inventory_dir = self.reports_dir.parent / "inventory"
        if not inventory_dir.exists():
            return {}

        inventory_data = {}
        for json_file in inventory_dir.glob("**/*.json"):
            try:
                with open(json_file, 'r') as f:
                    data = json.load(f)
                    relative_path = json_file.relative_to(inventory_dir)
                    inventory_data[str(relative_path)] = data
            except Exception as e:
                self.logger.error(f"Error loading inventory file {json_file}: {e}")

        return inventory_data

    def _generate_analysis(self) -> Dict[str, Any]:
        """Generate analysis insights from collected data"""
        analysis = {
            "critical_issues": [],
            "recommendations": [],
            "metrics": {},
            "trends": {}
        }

        # Analyze security data
        if self.security_data:
            critical_secrets = [
                issue for issue in self.security_data.get("secrets", [])
                if issue.get("severity", "").lower() == "critical"
            ]

            analysis["critical_issues"].extend([
                f"Critical secret found in {secret.get('file', 'unknown')}"
                for secret in critical_secrets
            ])

            analysis["metrics"]["security_score"] = max(0, 100 - len(critical_secrets) * 25)

        # Analyze drift data
        if self.drift_data:
            summary = self.drift_data.get("summary", {})
            total_drift = summary.get("critical_issues", 0) + summary.get("major_issues", 0)

            if total_drift > 0:
                analysis["critical_issues"].append(
                    f"Configuration drift detected: {total_drift} resources need attention"
                )

            analysis["metrics"]["drift_percentage"] = summary.get("drift_percentage", 0)

        # Generate recommendations
        if analysis["metrics"]["security_score"] < 75:
            analysis["recommendations"].append(
                "🔴 Implement immediate secret rotation and security scanning"
            )

        if analysis["metrics"]["drift_percentage"] > 10:
            analysis["recommendations"].append(
                "🟡 Review and update infrastructure configurations"
            )

        analysis["recommendations"].append(
            "🟢 Enable automated monitoring and alerting"
        )

        return analysis

class ReportGenerator:
    def __init__(self, reports_dir: str, config: Optional[ReportConfig] = None):
        self.reports_dir = Path(reports_dir)
        self.config = config or ReportConfig()
        self.logger = logging.getLogger(__name__)

        # Initialize Jinja2 environment
        if self.config.template_path:
            env = Environment(loader=FileSystemLoader(self.config.template_path))
        else:
            env = Environment(loader=FileSystemLoader())

        # Add custom filters
        env.filters['severity_color'] = self._severity_color_filter
        env.filters['format_timestamp'] = self._format_timestamp_filter

        self.jinja_env = env

    def _severity_color_filter(self, severity: str) -> str:
        """Jinja2 filter for severity colors"""
        colors = {
            'critical': '🔴',
            'high': '🟠',
            'medium': '🟡',
            'low': '🟢',
            'info': '🔵'
        }
        return colors.get(severity.lower(), '⚪')

    def _format_timestamp_filter(self, timestamp: str) -> str:
        """Jinja2 filter for timestamp formatting"""
        try:
            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            return dt.strftime('%Y-%m-%d %H:%M:%S')
        except:
            return timestamp

    def generate_executive_summary(self, data: ReportData) -> str:
        """Generate executive summary section"""
        template_str = """
# Executive Summary

## Overview
This report provides a comprehensive analysis of the infrastructure security posture, configuration drift, and operational metrics as of **{{ data.analysis.metrics.timestamp }}**.

## Key Findings

### 🔴 Critical Issues ({% for issue in data.analysis.critical_issues %}{{ loop.length }}{% endfor %})
{% for issue in data.analysis.critical_issues %}
- {{ issue }}
{% endfor %}

### 📊 Key Metrics
- **Security Score**: {{ "%.1f"|format(data.analysis.metrics.security_score or 0) }}/100
- **Configuration Drift**: {{ "%.1f"|format(data.analysis.metrics.drift_percentage or 0) }}%
- **Total Resources Monitored**: {{ data.drift_data.summary.total_resources or 0 }}

### 🎯 Immediate Actions Required
{% for rec in data.analysis.recommendations %}
{{ rec }}
{% endfor %}

---

*Generated on {{ data.analysis.metrics.timestamp }}*
        """

        template = Template(template_str)
        return template.render(data=data)

    def generate_security_analysis(self, data: ReportData) -> str:
        """Generate security analysis section"""
        security_data = data.security_data

        template_str = """
# Security Analysis

## Scan Summary
- **Scan Time**: {{ security_data.scan_time }}
- **Total Issues Found**: {{ security_data.total_issues }}
- **Files Scanned**: {{ security_data.files_scanned or 'N/A' }}

## Security Issues by Severity

{% for issue in security_data.secrets %}
### {{ issue.severity|severity_color }} {{ issue.severity|title }}
- **File**: `{{ issue.file }}`
- **Type**: {{ issue.type }}
- **Line**: {{ issue.line or 'N/A' }}

{% endfor %}

## Security Trends
{{ data.analysis.trends.security_trend or 'No trend data available' }}

## Recommendations
1. **Critical Issues**: Address immediately within 24 hours
2. **High Priority**: Remediate within 1 week
3. **Medium Priority**: Schedule for next maintenance window
4. **Low Priority**: Include in next security review

---

*Security analysis complete*
        """

        template = Template(template_str)
        return template.render(data=data, security_data=security_data)

    def generate_drift_analysis(self, data: ReportData) -> str:
        """Generate configuration drift analysis"""
        drift_data = data.drift_data

        template_str = """
# Configuration Drift Analysis

## Drift Summary
- **Total Resources**: {{ drift_data.summary.total_resources or 0 }}
- **Drifted Resources**: {{ drift_data.summary.drifted_resources or 0 }}
- **Drift Percentage**: {{ "%.1f"|format(drift_data.summary.drift_percentage or 0) }}%

## Drift Breakdown

### 🔴 Critical Issues ({{ drift_data.summary.critical_issues or 0 }})
{% for resource in drift_data.drifted_resources %}
{% if resource.severity == 'critical' %}
- **{{ resource.resource }}**: {{ resource.drift_type }}
{% endif %}
{% endfor %}

### 🟡 Major Issues ({{ drift_data.summary.major_issues or 0 }})
{% for resource in drift_data.drifted_resources %}
{% if resource.severity == 'major' %}
- **{{ resource.resource }}**: {{ resource.drift_type }}
{% endif %}
{% endfor %}

### 🟢 Minor Issues ({{ drift_data.summary.minor_issues or 0 }})
{% for resource in drift_data.drifted_resources %}
{% if resource.severity == 'minor' %}
- **{{ resource.resource }}**: {{ resource.drift_type }}
{% endif %}
{% endfor %}

## Root Cause Analysis
{{ data.analysis.trends.drift_root_cause or 'Root cause analysis not available' }}

## Remediation Steps
1. **Immediate**: Update configuration management system
2. **Short-term**: Implement automated drift detection
3. **Long-term**: Establish configuration as code practices

---

*Drift analysis complete*
        """

        template = Template(template_str)
        return template.render(data=data, drift_data=drift_data)

    def generate_recommendations(self, data: ReportData) -> str:
        """Generate recommendations section"""
        template_str = """
# Strategic Recommendations

## 🔴 Immediate Actions (Next 24-48 hours)

### Security
{% for rec in data.analysis.recommendations %}
{% if '🔴' in rec %}
- {{ rec.replace('🔴', '') }}
{% endif %}
{% endfor %}

### Configuration Management
- Review all critical security configurations
- Implement emergency secret rotation procedures
- Enable enhanced monitoring for critical systems

## 🟡 Short-term Improvements (1-4 weeks)

### Automation
{% for rec in data.analysis.recommendations %}
{% if '🟡' in rec %}
- {{ rec.replace('🟡', '') }}
{% endif %}
{% endfor %}

### Monitoring
- Deploy comprehensive monitoring solution
- Set up automated alerting for drift detection
- Implement performance baseline monitoring

## 🟢 Long-term Strategy (1-6 months)

### Infrastructure as Code
- Migrate all configurations to Infrastructure as Code
- Implement automated testing and validation
- Establish continuous compliance monitoring

### Process Improvement
- Develop security awareness training program
- Create incident response procedures
- Implement regular security audits

## Success Metrics
- **Security Score**: Target > 90%
- **Configuration Drift**: Target < 5%
- **Automated Coverage**: Target > 80%
- **Mean Time to Resolution**: Target < 4 hours

---

*Recommendations complete*
        """

        template = Template(template_str)
        return template.render(data=data)

    def generate_report(self, output_format: str = None) -> str:
        """Generate complete report"""
        output_format = output_format or self.config.format

        # Load data
        data = ReportData(str(self.reports_dir))

        # Generate sections
        sections = {}

        if "executive" in self.config.include_sections:
            sections["executive"] = self.generate_executive_summary(data)

        if "security" in self.config.include_sections:
            sections["security"] = self.generate_security_analysis(data)

        if "drift" in self.config.include_sections:
            sections["drift"] = self.generate_drift_analysis(data)

        if "recommendations" in self.config.include_sections:
            sections["recommendations"] = self.generate_recommendations(data)

        # Combine sections based on format
        if output_format.lower() == "markdown":
            report_content = "\n\n".join(sections.values())
            return self._add_markdown_header(report_content, data)

        elif output_format.lower() == "html":
            report_content = "\n\n".join(sections.values())
            html_content = markdown.markdown(report_content)
            return self._add_html_header(html_content, data)

        elif output_format.lower() == "json":
            return json.dumps({
                "metadata": {
                    "generated_at": datetime.now().isoformat(),
                    "format": output_format,
                    "sections": list(sections.keys())
                },
                "data": sections
            }, indent=2)

        else:
            raise ValueError(f"Unsupported output format: {output_format}")

    def _add_markdown_header(self, content: str, data: ReportData) -> str:
        """Add header to markdown report"""
        return f"""# {self.config.title}

**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
**Format**: Markdown
**Sections**: {', '.join(self.config.include_sections)}

---

{content}
"""

    def _add_html_header(self, content: str, data: ReportData) -> str:
        """Add header to HTML report"""
        return f"""<!DOCTYPE html>
<html>
<head>
    <title>{self.config.title}</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }}
        h1 {{ color: #2c3e50; border-bottom: 2px solid #3498db; }}
        h2 {{ color: #34495e; }}
        .metadata {{ background-color: #ecf0f1; padding: 10px; border-radius: 5px; }}
    </style>
</head>
<body>
    <div class="metadata">
        <strong>Generated:</strong> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}<br>
        <strong>Format:</strong> HTML<br>
        <strong>Sections:</strong> {', '.join(self.config.include_sections)}
    </div>

    {content}
</body>
</html>
"""

    def save_report(self, filename: str = None, output_format: str = None) -> Path:
        """Save report to file"""
        filename = filename or f"report.{output_format or self.config.format}"
        output_path = self.reports_dir / filename

        try:
            report_content = self.generate_report(output_format)

            with open(output_path, 'w') as f:
                f.write(report_content)

            self.logger.info(f"Report saved to: {output_path}")
            return output_path

        except Exception as e:
            self.logger.error(f"Failed to save report: {e}")
            raise

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Generate NOIP intelligence report")
    parser.add_argument("reports_dir", help="Directory containing report JSON files")
    parser.add_argument("--format", choices=["markdown", "html", "json"],
                       default="markdown", help="Output format")
    parser.add_argument("--output", help="Output filename")
    parser.add_argument("--sections", nargs="+",
                       choices=["executive", "security", "drift", "recommendations"],
                       default=["executive", "security", "drift", "recommendations"],
                       help="Report sections to include")
    parser.add_argument("--template", help="Custom template directory")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Enable verbose logging")

    args = parser.parse_args()

    # Setup logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format='%(asctime)s - %(levelname)s - %(message)s')

    try:
        config = ReportConfig(
            format=args.format,
            include_sections=args.sections,
            template_path=args.template
        )

        generator = ReportGenerator(args.reports_dir, config)
        output_path = generator.save_report(args.output, args.format)

        print(f"✅ Report generated successfully: {output_path}")

    except Exception as e:
        print(f"❌ Failed to generate report: {e}")
        import sys
        sys.exit(1)

if __name__ == "__main__":
    main()
```

## 📋 Implementation Plan Summary

### Phase 1: Foundation (Tasks 100-109)
1. **Requirements and Testing Setup** - Install dependencies, configure pytest
2. **Refactor Existing Scripts** - Add error handling, logging, validation
3. **Implement Missing generate_report.py** - Complete executive reporting
4. **Unit Tests** - Comprehensive test coverage for all components
5. **Integration Tests** - End-to-end workflow validation

### Phase 2: Enhancement (Tasks 110-119)
1. **Performance Optimization** - Caching, async processing
2. **Advanced Features** - Templates, custom reports, notifications
3. **Security Hardening** - Input validation, secure configurations
4. **Documentation** - API docs, user guides, troubleshooting

### Success Criteria
- [ ] 100% test coverage for new code
- [ ] All existing functionality preserved
- [ ] Error handling for all failure scenarios
- [ ] Performance benchmarks met
- [ ] Security vulnerabilities addressed
- [ ] Documentation complete

This TDD approach ensures robust, maintainable, and well-tested Python components that integrate seamlessly with the broader NOIP system.