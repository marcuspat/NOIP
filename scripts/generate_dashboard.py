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
