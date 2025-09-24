# NetOps Intelligence Platform (NOIP)

## 🎯 Platform Overview

The NetOps Intelligence Platform combines your tools into an automated pipeline that:
1. **Discovers** infrastructure (k8s-netinspect)
2. **Scans** for security issues (secret-scan)
3. **Detects** configuration drift (driftguard)
4. **Verifies** integrity (file-hasher)
5. **Analyzes** with AI (turbo-flow-claude)
6. **Secures** sensitive data (cargocrypt)
7. **Presents** results beautifully (json-prettify)

## 📁 Repository Structure

```
netops-intelligence-platform/
├── .github/
│   ├── workflows/
│   │   ├── infrastructure-scan.yml
│   │   ├── security-audit.yml
│   │   └── ai-analysis.yml
│   └── dependabot.yml
├── .devcontainer/
│   └── devcontainer.json
├── inventory/
│   ├── network/
│   ├── kubernetes/
│   └── cloud/
├── rag/
│   ├── embeddings/
│   └── vectors/
├── reports/
│   ├── daily/
│   └── incidents/
├── scripts/
│   ├── discovery.sh
│   ├── analysis.sh
│   └── report.sh
├── docker-compose.yml
├── Makefile
└── README.md
```

## 🔧 Core Components

### 1. Infrastructure Discovery Module

```yaml
# .github/workflows/infrastructure-scan.yml
name: Infrastructure Discovery & Analysis

on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours
  workflow_dispatch:
    inputs:
      target:
        description: 'Target environment'
        required: true
        default: 'production'
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  discover:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Tools
        run: |
          # Install all platform tools
          cargo install k8s-netinspect
          cargo install secret-scan
          cargo install driftguard
          cargo install file-hasher
          cargo install cargocrypt
          pip install json-prettify
          
      - name: Kubernetes Discovery
        run: |
          k8s-netinspect diagnose --output json > inventory/kubernetes/cluster-state.json
          k8s-netinspect diagnose --namespace production > inventory/kubernetes/prod-namespace.json
          
      - name: Security Scan
        run: |
          secret-scan . --format json --output reports/security-scan.json
          
      - name: Drift Detection
        run: |
          driftguard analyze . --recursive --output json --output-file reports/drift-report.json
          
      - name: Generate Inventory Hash
        run: |
          file-hasher inventory/*.json --algorithm sha256 > reports/inventory-integrity.txt
          
      - name: Upload to RAG
        run: |
          python scripts/update_rag.py inventory/ rag/
          
      - name: Encrypt Sensitive Reports
        run: |
          cargocrypt init
          cargocrypt encrypt reports/security-scan.json
          
      - name: Format Reports
        run: |
          json-prettify reports/*.json --stats --output reports/formatted/
          
      - name: Upload Artifacts
        uses: actions/upload-artifact@v3
        with:
          name: infrastructure-reports
          path: reports/
```

### 2. AI Analysis Pipeline

```yaml
# .github/workflows/ai-analysis.yml
name: AI Infrastructure Analysis

on:
  workflow_run:
    workflows: ["Infrastructure Discovery & Analysis"]
    types:
      - completed

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Claude Environment
        run: |
          # Clone turbo-flow-claude setup
          git clone https://github.com/marcuspat/turbo-flow-claude claude-env
          cd claude-env/devpods && ./setup.sh
          
      - name: Download Discovery Reports
        uses: actions/download-artifact@v3
        with:
          name: infrastructure-reports
          path: reports/
          
      - name: AI Analysis
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # Decrypt reports
          cargocrypt decrypt reports/security-scan.json.enc
          
          # Run AI analysis with context
          cat <<EOF | cf-swarm "Analyze infrastructure and provide recommendations"
          Infrastructure State:
          $(cat reports/drift-report.json)
          
          Security Issues:
          $(cat reports/security-scan.json)
          
          Network Topology:
          $(cat inventory/kubernetes/cluster-state.json)
          
          Provide:
          1. Critical security issues
          2. Performance optimizations
          3. Cost reduction opportunities
          4. Drift remediation steps
          EOF
          
      - name: Generate Executive Report
        run: |
          python scripts/generate_report.py reports/ > reports/executive-summary.md
          
      - name: Notify Teams
        if: contains(fromJson(steps.analyze.outputs.severity), 'critical')
        run: |
          # Send notifications for critical issues
          curl -X POST ${{ secrets.SLACK_WEBHOOK }} \
            -d '{"text":"Critical infrastructure issues detected. Check reports."}'
```

### 3. RAG Database Module

```python
# scripts/update_rag.py
#!/usr/bin/env python3
import json
import hashlib
from pathlib import Path
from datetime import datetime
import chromadb
from chromadb.config import Settings

class InfrastructureRAG:
    def __init__(self, persist_dir="./rag"):
        self.client = chromadb.Client(Settings(
            chroma_db_impl="duckdb+parquet",
            persist_directory=persist_dir
        ))
        self.collection = self.client.get_or_create_collection(
            name="infrastructure",
            metadata={"hnsw:space": "cosine"}
        )
    
    def update_inventory(self, inventory_path):
        """Update RAG with latest infrastructure inventory"""
        for json_file in Path(inventory_path).glob("**/*.json"):
            with open(json_file) as f:
                data = json.load(f)
            
            # Create document ID from content hash
            doc_id = hashlib.sha256(
                json.dumps(data, sort_keys=True).encode()
            ).hexdigest()[:16]
            
            # Prepare metadata
            metadata = {
                "source": str(json_file),
                "timestamp": datetime.now().isoformat(),
                "type": json_file.parent.name
            }
            
            # Add to collection
            self.collection.add(
                documents=[json.dumps(data)],
                metadatas=[metadata],
                ids=[doc_id]
            )
    
    def query_infrastructure(self, query, n_results=5):
        """Query infrastructure knowledge base"""
        results = self.collection.query(
            query_texts=[query],
            n_results=n_results
        )
        return results

if __name__ == "__main__":
    import sys
    rag = InfrastructureRAG()
    rag.update_inventory(sys.argv[1])
    print("RAG database updated successfully")
```

### 4. Dashboard Generator

```python
# scripts/generate_dashboard.py
#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime
import plotly.graph_objects as go
from plotly.subplots import make_subplots

class DashboardGenerator:
    def __init__(self, reports_dir):
        self.reports_dir = Path(reports_dir)
        self.drift_data = self.load_json("drift-report.json")
        self.security_data = self.load_json("security-scan.json")
        self.network_data = self.load_json("cluster-state.json")
    
    def load_json(self, filename):
        filepath = self.reports_dir / filename
        if filepath.exists():
            with open(filepath) as f:
                return json.load(f)
        return {}
    
    def generate_html_dashboard(self):
        fig = make_subplots(
            rows=2, cols=2,
            subplot_titles=(
                "Security Issues by Severity",
                "Configuration Drift Status",
                "Network Topology Health",
                "Resource Utilization"
            )
        )
        
        # Security chart
        if self.security_data:
            severities = {}
            for issue in self.security_data.get("secrets", []):
                sev = issue.get("severity", "unknown")
                severities[sev] = severities.get(sev, 0) + 1
            
            fig.add_trace(
                go.Bar(x=list(severities.keys()), y=list(severities.values())),
                row=1, col=1
            )
        
        # Drift chart
        if self.drift_data:
            drift_summary = self.drift_data.get("summary", {})
            fig.add_trace(
                go.Pie(
                    labels=["Critical", "Major", "Minor"],
                    values=[
                        drift_summary.get("critical_issues", 0),
                        drift_summary.get("major_issues", 0),
                        drift_summary.get("minor_issues", 0)
                    ]
                ),
                row=1, col=2
            )
        
        fig.update_layout(
            title="NetOps Intelligence Dashboard",
            showlegend=False,
            height=800
        )
        
        return fig.to_html()

if __name__ == "__main__":
    import sys
    generator = DashboardGenerator(sys.argv[1])
    dashboard_html = generator.generate_html_dashboard()
    
    output_path = Path(sys.argv[1]) / "dashboard.html"
    output_path.write_text(dashboard_html)
    print(f"Dashboard generated: {output_path}")
```

### 5. DevContainer Configuration

```json
{
  "name": "NetOps Intelligence Platform",
  "image": "mcr.microsoft.com/devcontainers/rust:1-bullseye",
  
  "features": {
    "ghcr.io/devcontainers/features/rust:1": {},
    "ghcr.io/devcontainers/features/python:1": {
      "version": "3.11"
    },
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    "ghcr.io/devcontainers/features/kubectl-helm-minikube:1": {}
  },
  
  "postCreateCommand": "make setup",
  
  "customizations": {
    "vscode": {
      "extensions": [
        "rust-lang.rust-analyzer",
        "ms-python.python",
        "ms-azuretools.vscode-docker",
        "ms-kubernetes-tools.vscode-kubernetes-tools"
      ]
    }
  },
  
  "forwardPorts": [8080, 6333],
  
  "mounts": [
    "source=${localWorkspaceFolder}/inventory,target=/workspace/inventory,type=bind",
    "source=${localWorkspaceFolder}/rag,target=/workspace/rag,type=bind"
  ]
}
```

### 6. Makefile for Easy Operations

```makefile
# Makefile
.PHONY: setup scan analyze report dashboard clean

setup:
	@echo "🚀 Setting up NetOps Intelligence Platform..."
	cargo install k8s-netinspect secret-scan driftguard file-hasher cargocrypt
	pip install -r requirements.txt
	mkdir -p inventory/network inventory/kubernetes inventory/cloud
	mkdir -p rag/embeddings rag/vectors
	mkdir -p reports/daily reports/incidents
	@echo "✅ Setup complete!"

scan:
	@echo "🔍 Running infrastructure scan..."
	./scripts/discovery.sh

analyze:
	@echo "🤖 Running AI analysis..."
	./scripts/analysis.sh

report:
	@echo "📊 Generating reports..."
	python scripts/generate_report.py reports/ > reports/executive-summary.md
	json-prettify reports/*.json --stats

dashboard:
	@echo "📈 Generating dashboard..."
	python scripts/generate_dashboard.py reports/
	@echo "Dashboard available at: reports/dashboard.html"

demo:
	@echo "🎯 Running demo pipeline..."
	make scan
	make analyze
	make report
	make dashboard
	@echo "✨ Demo complete! Check reports/dashboard.html"

clean:
	rm -rf reports/*.json reports/*.enc reports/formatted/
	@echo "🧹 Cleanup complete!"
```

## 🚀 Quick Start

### 1. GitHub Codespace Setup

1. Fork this repository
2. Click "Code" → "Create codespace on main"
3. Wait for environment setup (automated via devcontainer)
4. Run the demo:
   ```bash
   make demo
   ```

### 2. Local Setup

```bash
# Clone repository
git clone https://github.com/yourusername/netops-intelligence-platform
cd netops-intelligence-platform

# Setup environment
make setup

# Configure credentials
export KUBECONFIG=~/.kube/config
export ANTHROPIC_API_KEY=your-key-here

# Run full pipeline
make demo
```

### 3. GitHub Actions Setup

1. Add secrets to your repository:
   - `ANTHROPIC_API_KEY`
   - `SLACK_WEBHOOK` (optional)
   - `KUBECONFIG` (base64 encoded)

2. Enable GitHub Actions

3. The pipeline runs automatically every 6 hours or manually via Actions tab

## 📊 Example Output

### Security Report Summary
```json
{
  "scan_time": "2024-01-15T10:30:00Z",
  "total_secrets_found": 12,
  "critical_issues": 2,
  "affected_services": ["payment-api", "auth-service"],
  "recommendations": [
    "Rotate AWS credentials in payment-api immediately",
    "Remove hardcoded tokens from auth-service config"
  ]
}
```

### Drift Analysis
```json
{
  "infrastructure_drift": {
    "terraform_resources": 45,
    "drifted_resources": 7,
    "drift_percentage": 15.5,
    "critical_drift": [
      "Security group rules modified outside Terraform",
      "Instance type changed without updating configuration"
    ]
  }
}
```

### AI Recommendations
```markdown
## Infrastructure Optimization Report

### 🔴 Critical Issues (Immediate Action Required)
1. **Exposed AWS credentials** in payment-api configuration
2. **Unencrypted database connections** in production

### 🟡 Performance Optimizations
1. Scale down over-provisioned dev environment (save $450/month)
2. Enable autoscaling for API gateway

### 🟢 Best Practices
1. Implement secret rotation policy
2. Add monitoring for configuration drift
```

## 🎯 Key Features Demonstration

1. **Automated Discovery**: Continuously scans infrastructure
2. **Security Analysis**: Identifies secrets and vulnerabilities
3. **Drift Detection**: Compares actual vs desired state
4. **AI Insights**: Provides actionable recommendations
5. **RAG Integration**: Builds knowledge base over time
6. **Beautiful Reports**: JSON formatting with statistics
7. **Secure Storage**: Encrypts sensitive findings
8. **File Integrity**: Verifies configuration integrity

## 🔗 Integration Points

- **Kubernetes**: Direct cluster analysis
- **GitHub Actions**: Automated CI/CD pipeline
- **Slack/Teams**: Alert notifications
- **RAG Database**: Historical knowledge
- **Claude AI**: Intelligent analysis

## 📈 Metrics & Monitoring

The platform tracks:
- Infrastructure changes over time
- Security posture trends
- Cost optimization opportunities
- Compliance status
- Performance metrics

## 🛠️ Extending the Platform

Add new scanners:
1. Create scanner script in `scripts/scanners/`
2. Add to discovery pipeline
3. Update RAG ingestion
4. Add to dashboard visualization

## 📝 License

MIT License - Use freely in your organization

---

**Ready to revolutionize your infrastructure management with AI? Start with `make demo`!**
