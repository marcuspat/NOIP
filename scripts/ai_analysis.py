#!/usr/bin/env python3
"""
AI Analysis Script for NetOps Intelligence Platform
Analyzes infrastructure data using Claude AI to provide insights and recommendations.
"""

import argparse
import json
import os
import sys
import anthropic
from datetime import datetime
from typing import Dict, List, Any, Optional


class AIAnalyzer:
    """AI-powered infrastructure analysis using Claude."""

    def __init__(self, api_key: Optional[str] = None):
        """Initialize the AI analyzer."""
        self.api_key = api_key or os.getenv('ANTHROPIC_API_KEY')
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")

        self.client = anthropic.Anthropic(api_key=self.api_key)

    def load_data(self, data_dir: str) -> Dict[str, Any]:
        """Load analysis data from reports directory."""
        data = {}

        if not os.path.exists(data_dir):
            print(f"Warning: Data directory {data_dir} does not exist")
            return data

        for filename in os.listdir(data_dir):
            if filename.endswith('.json'):
                filepath = os.path.join(data_dir, filename)
                try:
                    with open(filepath, 'r') as f:
                        data[filename.replace('.json', '')] = json.load(f)
                    print(f"Loaded data from {filename}")
                except Exception as e:
                    print(f"Warning: Could not load {filename}: {e}")

        return data

    def create_analysis_prompt(self, data: Dict[str, Any], analysis_type: str) -> str:
        """Create a context-aware analysis prompt."""

        # Extract key metrics from available data
        security_metrics = self._extract_security_metrics(data)
        infrastructure_metrics = self._extract_infrastructure_metrics(data)
        drift_metrics = self._extract_drift_metrics(data)

        prompt = f"""# NetOps Infrastructure Analysis Request

## Analysis Configuration
- **Analysis Type:** {analysis_type}
- **Timestamp:** {datetime.now().isoformat()}
- **Data Sources:** {list(data.keys())}

## Current Infrastructure State

### Security Posture
- **Overall Security Score:** {security_metrics.get('overall_score', 'N/A')}
- **Critical Vulnerabilities:** {security_metrics.get('critical_vulnerabilities', 0)}
- **High Severity Issues:** {security_metrics.get('high_issues', 0)}
- **Secret Detection Findings:** {security_metrics.get('secret_findings', 0)}

### Infrastructure Overview
- **Total Resources:** {infrastructure_metrics.get('total_resources', 'N/A')}
- **Kubernetes Clusters:** {infrastructure_metrics.get('k8s_clusters', 0)}
- **Network Components:** {infrastructure_metrics.get('network_components', 0)}
- **Cloud Services:** {infrastructure_metrics.get('cloud_services', 0)}

### Configuration Drift
- **Drift Percentage:** {drift_metrics.get('drift_percentage', 'N/A')}%
- **Drifted Resources:** {drift_metrics.get('drifted_resources', 0)}
- **Critical Drift Issues:** {drift_metrics.get('critical_issues', 0)}

## Analysis Focus

Based on the analysis type "{analysis_type}", please provide:

"""

        # Add specific analysis requirements based on type
        if analysis_type == "comprehensive":
            prompt += """
### Comprehensive Analysis Requirements
1. **Security Assessment**
   - Critical vulnerability analysis and immediate remediation steps
   - Security posture evaluation and improvement recommendations
   - Threat landscape analysis based on current findings

2. **Performance Optimization**
   - Resource utilization analysis and scaling recommendations
   - Performance bottleneck identification and optimization strategies
   - Capacity planning suggestions

3. **Cost Optimization**
   - Resource over-provisioning analysis
   - Cost reduction opportunities without compromising security
   - ROI calculations for proposed changes

4. **Operational Excellence**
   - Configuration drift root cause analysis
   - Automation opportunities
   - Best practices recommendations

"""
        elif analysis_type == "security-focused":
            prompt += """
### Security-Focused Analysis Requirements
1. **Vulnerability Management**
   - Prioritization of critical and high-severity vulnerabilities
   - Patch management strategy
   - Vulnerability trending analysis

2. **Threat Assessment**
   - Current security posture evaluation
   - Potential attack vectors and mitigation strategies
   - Security controls effectiveness assessment

3. **Compliance Analysis**
   - Regulatory compliance gaps
   - Security policy recommendations
   - Audit preparation guidance

"""
        elif analysis_type == "performance-focused":
            prompt += """
### Performance-Focused Analysis Requirements
1. **Resource Optimization**
   - CPU, memory, and storage utilization analysis
   - Scaling recommendations
   - Performance bottleneck identification

2. **Network Performance**
   - Latency and throughput analysis
   - Network optimization suggestions
   - Load balancing recommendations

3. **Application Performance**
   - Application response time analysis
   - Database performance optimization
   - Caching strategies

"""
        elif analysis_type == "cost-optimization":
            prompt += """
### Cost Optimization Analysis Requirements
1. **Resource Efficiency**
   - Over-provisioned resource identification
   - Rightsizing recommendations
   - Instance type optimization

2. **Cost Analysis**
   - Cost breakdown by service/component
   - Cost reduction opportunities
   - Reserved instance/savings plan analysis

3. **Financial Optimization**
   - TCO (Total Cost of Ownership) analysis
   - ROI calculations for optimizations
   - Budget planning recommendations

"""

        prompt += """
## Expected Output Format

Please provide a structured analysis with:

### Executive Summary
- Key findings and their business impact
- Critical issues requiring immediate attention
- Overall infrastructure health assessment

### Detailed Analysis
- In-depth analysis of each category
- Root cause analysis for identified issues
- Specific recommendations with implementation guidance

### Action Items
- High-priority action items (0-30 days)
- Medium-priority improvements (30-90 days)
- Long-term strategic recommendations (90+ days)

### Success Metrics
- KPIs to measure improvement
- Expected outcomes from recommendations
- Monitoring and reporting suggestions

Please provide actionable, specific, and prioritized recommendations that can be implemented to improve the infrastructure.
"""

        return prompt

    def _extract_security_metrics(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Extract security metrics from loaded data."""
        metrics = {
            'overall_score': 85,
            'critical_vulnerabilities': 0,
            'high_issues': 0,
            'secret_findings': 0
        }

        # Extract from security scan data
        if 'security-scan' in data:
            security_data = data['security-scan']
            if 'scan_results' in security_data:
                results = security_data['scan_results']
                metrics['critical_vulnerabilities'] = results.get('critical', 0)
                metrics['high_issues'] = results.get('high', 0)
                metrics['overall_score'] = max(0, 100 - (results.get('critical', 0) * 10) - (results.get('high', 0) * 5))

        # Extract from secret scan data
        if 'secret-scan' in data:
            secret_data = data['secret-scan']
            metrics['secret_findings'] = secret_data.get('secrets_found', 0)

        return metrics

    def _extract_infrastructure_metrics(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Extract infrastructure metrics from loaded data."""
        metrics = {
            'total_resources': 0,
            'k8s_clusters': 0,
            'network_components': 0,
            'cloud_services': 0
        }

        # Extract from infrastructure data
        if 'infrastructure-data' in data:
            infra_data = data['infrastructure-data']

            # Kubernetes metrics
            if 'kubernetes' in infra_data:
                k8s = infra_data['kubernetes']
                metrics['k8s_clusters'] = len(k8s.get('clusters', []))

                # Count total resources
                for cluster in k8s.get('clusters', []):
                    metrics['total_resources'] += cluster.get('nodes', 0)
                    metrics['total_resources'] += cluster.get('pods', 0)

            # Network metrics
            if 'network' in infra_data:
                network = infra_data['network']
                metrics['network_components'] = (
                    network.get('subnets', 0) +
                    network.get('instances', 0) +
                    network.get('load_balancers', 0) +
                    network.get('security_groups', 0)
                )

            # Cloud metrics
            if 'cloud' in infra_data:
                cloud = infra_data['cloud']
                metrics['cloud_services'] = cloud.get('services', 0)
                metrics['total_resources'] += metrics['cloud_services']

        return metrics

    def _extract_drift_metrics(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Extract drift metrics from loaded data."""
        metrics = {
            'drift_percentage': 0,
            'drifted_resources': 0,
            'critical_issues': 0
        }

        # Extract from drift detection data
        if 'drift-detection' in data:
            drift_data = data['drift-detection']
            if 'drift_analysis' in drift_data:
                analysis = drift_data['drift_analysis']
                metrics['drift_percentage'] = analysis.get('drift_percentage', 0)
                metrics['drifted_resources'] = analysis.get('drifted_resources', 0)

                if 'summary' in analysis:
                    summary = analysis['summary']
                    metrics['critical_issues'] = summary.get('critical_issues', 0)

        return metrics

    def analyze(self, data: Dict[str, Any], analysis_type: str = 'comprehensive') -> str:
        """Perform AI analysis on the infrastructure data."""
        try:
            prompt = self.create_analysis_prompt(data, analysis_type)

            print(f"Running {analysis_type} analysis with Claude AI...")

            response = self.client.messages.create(
                model="claude-3-sonnet-20240229",
                max_tokens=2000,
                temperature=0.3,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )

            return response.content[0].text

        except Exception as e:
            print(f"Error running AI analysis: {e}")
            return f"AI Analysis Error: {str(e)}\n\nPlease check the ANTHROPIC_API_KEY and ensure the service is available."

    def generate_report(self, analysis_result: str, data: Dict[str, Any], analysis_type: str) -> Dict[str, Any]:
        """Generate a comprehensive analysis report."""

        # Extract metrics for the report
        security_metrics = self._extract_security_metrics(data)
        infrastructure_metrics = self._extract_infrastructure_metrics(data)
        drift_metrics = self._extract_drift_metrics(data)

        report = {
            "metadata": {
                "timestamp": datetime.now().isoformat(),
                "analysis_type": analysis_type,
                "data_sources": list(data.keys()),
                "version": "1.0"
            },
            "metrics": {
                "security": security_metrics,
                "infrastructure": infrastructure_metrics,
                "drift": drift_metrics
            },
            "analysis_result": analysis_result,
            "raw_data_summary": {
                key: len(value) if isinstance(value, (list, dict)) else "processed"
                for key, value in data.items()
            }
        }

        return report

    def save_report(self, report: Dict[str, Any], output_dir: str = 'reports') -> str:
        """Save the analysis report to file."""
        os.makedirs(output_dir, exist_ok=True)

        filename = f"ai-analysis-report.json"
        filepath = os.path.join(output_dir, filename)

        try:
            with open(filepath, 'w') as f:
                json.dump(report, f, indent=2)

            print(f"Analysis report saved to: {filepath}")
            return filepath

        except Exception as e:
            print(f"Error saving report: {e}")
            return ""


def main():
    """Main entry point for the AI analysis script."""
    parser = argparse.ArgumentParser(
        description="AI-powered infrastructure analysis using Claude",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ai_analysis.py --data-dir reports/ --analysis-type comprehensive
  python ai_analysis.py --data-dir reports/ --analysis-type security-focused
  python ai_analysis.py --output-dir custom_reports/ --analysis-type performance-focused
        """
    )

    parser.add_argument(
        "--data-dir",
        default="reports/",
        help="Directory containing analysis data (default: reports/)"
    )

    parser.add_argument(
        "--analysis-type",
        choices=['comprehensive', 'security-focused', 'performance-focused', 'cost-optimization'],
        default='comprehensive',
        help="Type of analysis to perform (default: comprehensive)"
    )

    parser.add_argument(
        "--output-dir",
        default="reports/",
        help="Output directory for analysis report (default: reports/)"
    )

    parser.add_argument(
        "--print-summary",
        action="store_true",
        help="Print a summary of the analysis to stdout"
    )

    args = parser.parse_args()

    try:
        # Initialize AI analyzer
        print("🤖 Initializing AI analyzer...")
        analyzer = AIAnalyzer()

        # Load data
        print(f"📊 Loading data from {args.data_dir}...")
        data = analyzer.load_data(args.data_dir)

        if not data:
            print("❌ No data found for analysis")
            sys.exit(1)

        print(f"✅ Loaded data from {len(data)} sources")

        # Perform analysis
        print(f"🧠 Running {args.analysis_type} analysis...")
        analysis_result = analyzer.analyze(data, args.analysis_type)

        if not analysis_result.startswith("AI Analysis Error"):
            print("✅ Analysis completed successfully")
        else:
            print("⚠️ Analysis completed with warnings")

        # Generate and save report
        print("📝 Generating analysis report...")
        report = analyzer.generate_report(analysis_result, data, args.analysis_type)
        report_path = analyzer.save_report(report, args.output_dir)

        if args.print_summary:
            print("\n" + "="*60)
            print("📊 ANALYSIS SUMMARY")
            print("="*60)
            print(f"Analysis Type: {report['metadata']['analysis_type']}")
            print(f"Data Sources: {', '.join(report['metadata']['data_sources'])}")
            print(f"Timestamp: {report['metadata']['timestamp']}")
            print(f"Security Score: {report['metrics']['security']['overall_score']}")
            print(f"Critical Vulnerabilities: {report['metrics']['security']['critical_vulnerabilities']}")
            print(f"Drift Percentage: {report['metrics']['drift']['drift_percentage']}%")
            print(f"Total Resources: {report['metrics']['infrastructure']['total_resources']}")

            if not analysis_result.startswith("AI Analysis Error"):
                print("\n🔍 KEY INSIGHTS:")
                # Print first 500 characters of analysis
                insights = analysis_result[:500] + "..." if len(analysis_result) > 500 else analysis_result
                print(insights)

        if report_path:
            print(f"\n✅ Report saved to: {report_path}")

        print("\n🎉 AI analysis completed!")

    except KeyboardInterrupt:
        print("\n⚠️ Analysis interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()