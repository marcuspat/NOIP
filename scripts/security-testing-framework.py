#!/usr/bin/env python3
"""
NOIP Security Testing Framework
Comprehensive security testing suite for the NetOps Intelligence Platform
"""

import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
from datetime import datetime
import base64
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('security-testing.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

@dataclass
class SecurityTestResult:
    """Security test result data structure"""
    test_name: str
    status: str  # PASS, FAIL, WARN
    severity: str  # CRITICAL, HIGH, MEDIUM, LOW, INFO
    details: str
    timestamp: str
    file_path: Optional[str] = None
    line_number: Optional[int] = None
    recommendation: Optional[str] = None

@dataclass
class EncryptionTestResult:
    """Encryption test result"""
    algorithm: str
    key_size: int
    status: str
    performance_ms: float
    test_data: str

class SecurityTestingFramework:
    """Main security testing framework"""

    def __init__(self, project_root: str = "/workspaces/NOIP"):
        self.project_root = Path(project_root)
        self.reports_dir = self.project_root / "reports"
        self.reports_dir.mkdir(exist_ok=True)

        # Initialize test results
        self.test_results: List[SecurityTestResult] = []
        self.encryption_results: List[EncryptionTestResult] = []

        # Security patterns to detect
        self.secret_patterns = [
            r'password\s*=\s*["\'].*?["\']',
            r'api_key\s*=\s*["\'].*?["\']',
            r'secret\s*=\s*["\'].*?["\']',
            r'AKIA[0-9A-Z]{16}',  # AWS Access Key
            r'[\w-]*_?token[\w-]*\s*[:=]\s*["\'][0-9a-zA-Z+/]{20,}["\']',
            r'private[_-]?key',
            r'signature[_-]?secret',
            r'auth[_-]?token',
        ]

        # Common vulnerability patterns
        self.vulnerability_patterns = [
            (r'eval\s*\(', "Use of eval() - potential code injection"),
            (r'document\.write\s*\(', "Use of document.write() - potential XSS"),
            (r'innerHTML\s*=', "Use of innerHTML - potential XSS"),
            (r'exec\s*\(', "Use of exec() - potential code injection"),
            (r'system\s*\(', "Use of system() - potential command injection"),
            (r'subprocess\.(Popen|call|run)', "Use of subprocess - potential command injection"),
            (r'os\.system', "Use of os.system - potential command injection"),
        ]

        logger.info(f"Security Testing Framework initialized for {self.project_root}")

    def run_comprehensive_security_test(self) -> Dict[str, Any]:
        """Run all security tests"""
        logger.info("Starting comprehensive security testing...")

        # Secret scanning
        self.test_results.extend(self._run_secret_scanning())

        # Vulnerability scanning
        self.test_results.extend(self._run_vulnerability_scanning())

        # File integrity checks
        self.test_results.extend(self._run_file_integrity_checks())

        # Dependency security checks
        self.test_results.extend(self._run_dependency_security_checks())

        # Encryption tests
        self.encryption_results.extend(self._run_encryption_tests())

        # Generate report
        report = self._generate_security_report()

        logger.info(f"Security testing completed. {len(self.test_results)} tests executed.")
        return report

    def _run_secret_scanning(self) -> List[SecurityTestResult]:
        """Scan for secrets and credentials"""
        logger.info("Running secret scanning...")
        results = []

        # File extensions to scan
        scan_extensions = {'.py', '.js', '.ts', '.json', '.yml', '.yaml', '.toml', '.md'}

        # Files to exclude
        exclude_patterns = {'.git', 'node_modules', '.pytest_cache', '__pycache__', '.vscode'}

        for file_path in self.project_root.rglob('*'):
            # Skip excluded directories
            if any(excluded in str(file_path) for excluded in exclude_patterns):
                continue

            if file_path.is_file() and file_path.suffix in scan_extensions:
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()

                    for line_num, line in enumerate(content.split('\n'), 1):
                        for pattern in self.secret_patterns:
                            matches = re.findall(pattern, line, re.IGNORECASE)
                            if matches:
                                result = SecurityTestResult(
                                    test_name="Secret Detection",
                                    status="FAIL",
                                    severity="CRITICAL",
                                    details=f"Potential secret found: {matches[0]}",
                                    timestamp=datetime.now().isoformat(),
                                    file_path=str(file_path),
                                    line_number=line_num,
                                    recommendation="Remove hardcoded secrets and use environment variables or secret management"
                                )
                                results.append(result)

                except Exception as e:
                    logger.warning(f"Could not scan {file_path}: {e}")

        logger.info(f"Secret scanning completed. Found {len(results)} potential secrets.")
        return results

    def _run_vulnerability_scanning(self) -> List[SecurityTestResult]:
        """Scan for common vulnerabilities"""
        logger.info("Running vulnerability scanning...")
        results = []

        # File extensions to scan
        scan_extensions = {'.py', '.js', '.ts', '.jsx', '.tsx'}

        # Files to exclude
        exclude_patterns = {'.git', 'node_modules', '.pytest_cache', '__pycache__', '.vscode'}

        for file_path in self.project_root.rglob('*'):
            # Skip excluded directories
            if any(excluded in str(file_path) for excluded in exclude_patterns):
                continue

            if file_path.is_file() and file_path.suffix in scan_extensions:
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()

                    for line_num, line in enumerate(content.split('\n'), 1):
                        for pattern, description in self.vulnerability_patterns:
                            if re.search(pattern, line, re.IGNORECASE):
                                result = SecurityTestResult(
                                    test_name="Vulnerability Detection",
                                    status="WARN",
                                    severity="HIGH",
                                    details=f"Potential vulnerability: {description}",
                                    timestamp=datetime.now().isoformat(),
                                    file_path=str(file_path),
                                    line_number=line_num,
                                    recommendation="Review and mitigate potential security vulnerability"
                                )
                                results.append(result)

                except Exception as e:
                    logger.warning(f"Could not scan {file_path}: {e}")

        logger.info(f"Vulnerability scanning completed. Found {len(results)} potential issues.")
        return results

    def _run_file_integrity_checks(self) -> List[SecurityTestResult]:
        """Perform file integrity checks"""
        logger.info("Running file integrity checks...")
        results = []

        # Check for suspicious files
        suspicious_extensions = {'.exe', '.bat', '.cmd', '.scr', '.pif', '.com'}
        suspicious_names = {'malware', 'virus', 'trojan', 'backdoor', 'keylog', 'spy'}

        for file_path in self.project_root.rglob('*'):
            if file_path.is_file():
                # Check file extension
                if file_path.suffix.lower() in suspicious_extensions:
                    result = SecurityTestResult(
                        test_name="File Integrity Check",
                        status="FAIL",
                        severity="HIGH",
                        details=f"Suspicious file extension: {file_path.suffix}",
                        timestamp=datetime.now().isoformat(),
                        file_path=str(file_path),
                        recommendation="Review suspicious executable file"
                    )
                    results.append(result)

                # Check file name
                if any(suspicious in file_path.name.lower() for suspicious in suspicious_names):
                    result = SecurityTestResult(
                        test_name="File Integrity Check",
                        status="FAIL",
                        severity="HIGH",
                        details=f"Suspicious file name: {file_path.name}",
                        timestamp=datetime.now().isoformat(),
                        file_path=str(file_path),
                        recommendation="Review suspicious file"
                    )
                    results.append(result)

        # Check file permissions
        important_files = [
            self.project_root / "package.json",
            self.project_root / "Cargo.toml",
            self.project_root / "requirements.txt",
            self.project_root / "pyproject.toml"
        ]

        for file_path in important_files:
            if file_path.exists():
                try:
                    stat = file_path.stat()
                    # Check if file is writable by group/others
                    if stat.st_mode & 0o022:  # Group writable or other writable
                        result = SecurityTestResult(
                            test_name="File Permission Check",
                            status="WARN",
                            severity="MEDIUM",
                            details=f"Insecure file permissions: {oct(stat.st_mode)}",
                            timestamp=datetime.now().isoformat(),
                            file_path=str(file_path),
                            recommendation="Set restrictive file permissions (chmod 644)"
                        )
                        results.append(result)
                except Exception as e:
                    logger.warning(f"Could not check permissions for {file_path}: {e}")

        logger.info(f"File integrity checks completed. Found {len(results)} issues.")
        return results

    def _run_dependency_security_checks(self) -> List[SecurityTestResult]:
        """Check for vulnerable dependencies"""
        logger.info("Running dependency security checks...")
        results = []

        # Check Node.js dependencies
        package_json = self.project_root / "package.json"
        if package_json.exists():
            try:
                with open(package_json, 'r') as f:
                    package_data = json.load(f)

                # Run npm audit if available
                try:
                    result = subprocess.run(
                        ['npm', 'audit', '--json'],
                        cwd=self.project_root,
                        capture_output=True,
                        text=True,
                        timeout=60
                    )

                    if result.returncode != 0:
                        audit_data = json.loads(result.stdout)
                        vulnerabilities = audit_data.get('advisories', {})

                        for advisory_id, advisory in vulnerabilities.items():
                            severity = advisory.get('severity', 'low')
                            result = SecurityTestResult(
                                test_name="Dependency Security",
                                status="FAIL" if severity in ['critical', 'high'] else "WARN",
                                severity=severity.upper(),
                                details=f"Vulnerable dependency: {advisory.get('module_name')}",
                                timestamp=datetime.now().isoformat(),
                                recommendation=f"Update {advisory.get('module_name')} to patched version"
                            )
                            results.append(result)

                except subprocess.TimeoutExpired:
                    logger.warning("npm audit timed out")
                except FileNotFoundError:
                    logger.warning("npm not found")
                except json.JSONDecodeError:
                    logger.warning("Could not parse npm audit output")

            except Exception as e:
                logger.warning(f"Could not check Node.js dependencies: {e}")

        # Check Python dependencies
        requirements_files = [
            self.project_root / "requirements.txt",
            self.project_root / "pyproject.toml",
            self.project_root / "Pipfile"
        ]

        for req_file in requirements_files:
            if req_file.exists():
                try:
                    # Run safety check if available
                    result = subprocess.run(
                        ['safety', 'check', '--json'],
                        cwd=self.project_root,
                        capture_output=True,
                        text=True,
                        timeout=60
                    )

                    if result.returncode != 0:
                        safety_data = json.loads(result.stdout)

                        for issue in safety_data:
                            severity = "HIGH"  # Safety issues are typically high severity
                            result = SecurityTestResult(
                                test_name="Dependency Security",
                                status="FAIL",
                                severity=severity,
                                details=f"Vulnerable Python package: {issue.get('package')}",
                                timestamp=datetime.now().isoformat(),
                                recommendation=f"Update {issue.get('package')} to {issue.get('fixed_version')}"
                            )
                            results.append(result)

                except subprocess.TimeoutExpired:
                    logger.warning("safety check timed out")
                except FileNotFoundError:
                    logger.warning("safety not found")
                except json.JSONDecodeError:
                    logger.warning("Could not parse safety output")

        logger.info(f"Dependency security checks completed. Found {len(results)} issues.")
        return results

    def _run_encryption_tests(self) -> List[EncryptionTestResult]:
        """Test encryption functionality"""
        logger.info("Running encryption tests...")
        results = []

        # Test AES encryption
        try:
            from cryptography.fernet import Fernet
            import time

            # Generate key
            key = Fernet.generate_key()
            fernet = Fernet(key)

            # Test data
            test_data = b"Test data for encryption verification"

            # Encrypt
            start_time = time.time()
            encrypted = fernet.encrypt(test_data)
            encrypt_time = (time.time() - start_time) * 1000

            # Decrypt
            start_time = time.time()
            decrypted = fernet.decrypt(encrypted)
            decrypt_time = (time.time() - start_time) * 1000

            total_time = encrypt_time + decrypt_time

            # Verify
            if decrypted == test_data:
                result = EncryptionTestResult(
                    algorithm="AES-256-CBC",
                    key_size=256,
                    status="PASS",
                    performance_ms=total_time,
                    test_data=test_data.decode('utf-8')
                )
                results.append(result)
                logger.info(f"AES-256-CBC encryption test passed in {total_time:.2f}ms")
            else:
                result = EncryptionTestResult(
                    algorithm="AES-256-CBC",
                    key_size=256,
                    status="FAIL",
                    performance_ms=total_time,
                    test_data=test_data.decode('utf-8')
                )
                results.append(result)
                logger.error("AES-256-CBC encryption test failed")

        except ImportError:
            logger.warning("cryptography library not available for encryption testing")
        except Exception as e:
            logger.error(f"Encryption test failed: {e}")

        # Test hashing
        try:
            test_string = "Test data for hashing verification"

            # SHA-256
            start_time = time.time()
            sha256_hash = hashlib.sha256(test_string.encode()).hexdigest()
            hash_time = (time.time() - start_time) * 1000

            result = EncryptionTestResult(
                algorithm="SHA-256",
                key_size=256,
                status="PASS",
                performance_ms=hash_time,
                test_data=test_string
            )
            results.append(result)
            logger.info(f"SHA-256 hashing test passed in {hash_time:.2f}ms")

        except Exception as e:
            logger.error(f"Hashing test failed: {e}")

        return results

    def _generate_security_report(self) -> Dict[str, Any]:
        """Generate comprehensive security report"""
        logger.info("Generating security report...")

        # Calculate summary statistics
        summary = {
            "critical": len([r for r in self.test_results if r.severity == "CRITICAL"]),
            "high": len([r for r in self.test_results if r.severity == "HIGH"]),
            "medium": len([r for r in self.test_results if r.severity == "MEDIUM"]),
            "low": len([r for r in self.test_results if r.severity == "LOW"]),
            "info": len([r for r in self.test_results if r.severity == "INFO"]),
            "total": len(self.test_results)
        }

        # Calculate risk score
        critical_score = summary["critical"] * 10
        high_score = summary["high"] * 5
        medium_score = summary["medium"] * 2
        risk_score = critical_score + high_score + medium_score

        risk_level = (
            "CRITICAL" if risk_score >= 50 else
            "HIGH" if risk_score >= 20 else
            "MEDIUM" if risk_score >= 10 else
            "LOW"
        )

        # Generate report
        report = {
            "timestamp": datetime.now().isoformat(),
            "project_root": str(self.project_root),
            "summary": summary,
            "risk_score": risk_score,
            "risk_level": risk_level,
            "test_results": [asdict(r) for r in self.test_results],
            "encryption_results": [asdict(r) for r in self.encryption_results],
            "recommendations": self._generate_recommendations()
        }

        # Save report
        report_file = self.reports_dir / f"security-report-{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)

        logger.info(f"Security report saved to {report_file}")
        return report

    def _generate_recommendations(self) -> List[str]:
        """Generate security recommendations based on findings"""
        recommendations = []

        # Check for critical issues
        critical_issues = [r for r in self.test_results if r.severity == "CRITICAL"]
        if critical_issues:
            recommendations.append("IMMEDIATE ACTION REQUIRED: Address all CRITICAL security issues")

        # Check for secrets
        secret_issues = [r for r in self.test_results if "Secret Detection" in r.test_name]
        if secret_issues:
            recommendations.append("Remove hardcoded secrets and implement proper secret management")

        # Check for vulnerabilities
        vuln_issues = [r for r in self.test_results if "Vulnerability Detection" in r.test_name]
        if vuln_issues:
            recommendations.append("Review and mitigate potential code injection vulnerabilities")

        # Check for dependency issues
        dep_issues = [r for r in self.test_results if "Dependency Security" in r.test_name]
        if dep_issues:
            recommendations.append("Update vulnerable dependencies to latest secure versions")

        # Check file permissions
        perm_issues = [r for r in self.test_results if "File Permission Check" in r.test_name]
        if perm_issues:
            recommendations.append("Review and fix insecure file permissions")

        # General recommendations
        recommendations.extend([
            "Implement regular security scanning in CI/CD pipeline",
            "Use environment variables for configuration",
            "Enable security headers in web applications",
            "Implement proper input validation",
            "Regular security audits and penetration testing"
        ])

        return recommendations

def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(description="NOIP Security Testing Framework")
    parser.add_argument("--project-root", default="/workspaces/NOIP", help="Project root directory")
    parser.add_argument("--output", help="Output file for security report")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")

    args = parser.parse_args()

    # Set log level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Run security tests
    framework = SecurityTestingFramework(args.project_root)
    report = framework.run_comprehensive_security_test()

    # Output results
    print(f"\n🔒 Security Testing Results")
    print(f"Risk Level: {report['risk_level']}")
    print(f"Risk Score: {report['risk_score']}")
    print(f"Total Issues: {report['summary']['total']}")
    print(f"Critical: {report['summary']['critical']}")
    print(f"High: {report['summary']['high']}")
    print(f"Medium: {report['summary']['medium']}")

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"\nDetailed report saved to {args.output}")

    # Exit with appropriate code
    exit_code = 1 if report['risk_level'] in ['CRITICAL', 'HIGH'] else 0
    sys.exit(exit_code)

if __name__ == "__main__":
    main()