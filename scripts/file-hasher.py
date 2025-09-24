#!/usr/bin/env python3
"""
NOIP File Hasher - Integrity Verification System
Comprehensive file integrity monitoring and verification
"""

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any, Union
from dataclasses import dataclass, asdict
from datetime import datetime
import logging
import base64
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import sqlite3

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('file-hasher.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

@dataclass
class FileHash:
    """File hash data structure"""
    file_path: str
    hash_algorithm: str
    hash_value: str
    file_size: int
    last_modified: str
    permissions: str
    file_type: str
    scanned_at: str
    is_critical: bool = False
    signature: Optional[str] = None

@dataclass
class IntegrityCheck:
    """Integrity check result"""
    file_path: str
    check_type: str  # HASH, PERMISSION, SIZE, SIGNATURE
    status: str  # PASS, FAIL, WARN
    details: str
    timestamp: str
    expected_value: Optional[str] = None
    actual_value: Optional[str] = None

class FileHasher:
    """Main file hasher and integrity verification system"""

    def __init__(self, project_root: str = "/workspaces/NOIP", db_path: Optional[str] = None):
        self.project_root = Path(project_root)
        self.db_path = Path(db_path) if db_path else self.project_root / "file_hashes.db"
        self.reports_dir = self.project_root / "reports"
        self.reports_dir.mkdir(exist_ok=True)

        # Supported hash algorithms
        self.supported_algorithms = {
            'sha256': hashlib.sha256,
            'sha384': hashlib.sha384,
            'sha512': hashlib.sha512,
            'sha1': hashlib.sha1,
            'md5': hashlib.md5,
            'blake2b': hashlib.blake2b,
            'blake2s': hashlib.blake2s
        }

        # Initialize database
        self._init_database()

        # Critical file patterns
        self.critical_patterns = [
            '*.py', '*.js', '*.ts', '*.jsx', '*.tsx',  # Source code
            '*.json', '*.yml', '*.yaml', '*.toml',     # Config files
            '*.sh', '*.bat', '*.cmd',                   # Scripts
            'package.json', 'requirements.txt', 'Cargo.toml', 'pyproject.toml',  # Dependencies
            '*.key', '*.pem', '*.crt', '*.csr'          # Security files
        ]

        # Excluded directories
        self.excluded_dirs = {
            '.git', 'node_modules', '.pytest_cache', '__pycache__',
            '.vscode', '.idea', 'target', 'build', 'dist'
        }

        logger.info(f"File Hasher initialized for {self.project_root}")

    def _init_database(self):
        """Initialize SQLite database for hash storage"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()

                # Create file_hashes table
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS file_hashes (
                        file_path TEXT PRIMARY KEY,
                        hash_algorithm TEXT,
                        hash_value TEXT,
                        file_size INTEGER,
                        last_modified TEXT,
                        permissions TEXT,
                        file_type TEXT,
                        scanned_at TEXT,
                        is_critical BOOLEAN,
                        signature TEXT
                    )
                ''')

                # Create integrity_checks table
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS integrity_checks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        file_path TEXT,
                        check_type TEXT,
                        status TEXT,
                        details TEXT,
                        timestamp TEXT,
                        expected_value TEXT,
                        actual_value TEXT
                    )
                ''')

                # Create indexes
                cursor.execute('CREATE INDEX IF NOT EXISTS idx_file_path ON file_hashes(file_path)')
                cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON integrity_checks(timestamp)')

                conn.commit()
                logger.info("Database initialized successfully")

        except Exception as e:
            logger.error(f"Database initialization failed: {e}")
            raise

    def compute_file_hash(self, file_path: Path, algorithm: str = 'sha256') -> Optional[FileHash]:
        """Compute hash of a single file"""
        try:
            if not file_path.exists():
                logger.warning(f"File not found: {file_path}")
                return None

            hash_func = self.supported_algorithms.get(algorithm)
            if not hash_func:
                logger.error(f"Unsupported hash algorithm: {algorithm}")
                return None

            # Get file information
            stat = file_path.stat()
            file_size = stat.st_size
            last_modified = datetime.fromtimestamp(stat.st_mtime).isoformat()
            permissions = oct(stat.st_mode)[-3:]
            file_type = file_path.suffix.lower()

            # Compute hash
            hasher = hash_func()
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    hasher.update(chunk)

            hash_value = hasher.hexdigest()

            # Check if file is critical
            is_critical = any(file_path.match(pattern) for pattern in self.critical_patterns)

            file_hash = FileHash(
                file_path=str(file_path),
                hash_algorithm=algorithm,
                hash_value=hash_value,
                file_size=file_size,
                last_modified=last_modified,
                permissions=permissions,
                file_type=file_type,
                scanned_at=datetime.now().isoformat(),
                is_critical=is_critical
            )

            return file_hash

        except Exception as e:
            logger.error(f"Error computing hash for {file_path}: {e}")
            return None

    def compute_directory_hashes(self, directory: Path, algorithm: str = 'sha256', max_workers: int = 4) -> List[FileHash]:
        """Compute hashes for all files in a directory"""
        logger.info(f"Computing hashes for directory: {directory}")
        hashes = []

        # Collect files to process
        files_to_process = []
        for file_path in directory.rglob('*'):
            # Skip excluded directories
            if any(excluded in str(file_path) for excluded in self.excluded_dirs):
                continue

            if file_path.is_file():
                files_to_process.append(file_path)

        # Process files in parallel
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit all tasks
            future_to_file = {
                executor.submit(self.compute_file_hash, file_path, algorithm): file_path
                for file_path in files_to_process
            }

            # Collect results
            for future in as_completed(future_to_file):
                file_path = future_to_file[future]
                try:
                    file_hash = future.result()
                    if file_hash:
                        hashes.append(file_hash)
                except Exception as e:
                    logger.error(f"Error processing {file_path}: {e}")

        logger.info(f"Computed {len(hashes)} file hashes")
        return hashes

    def store_file_hash(self, file_hash: FileHash):
        """Store file hash in database"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()

                cursor.execute('''
                    INSERT OR REPLACE INTO file_hashes
                    (file_path, hash_algorithm, hash_value, file_size, last_modified,
                     permissions, file_type, scanned_at, is_critical, signature)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    file_hash.file_path, file_hash.hash_algorithm, file_hash.hash_value,
                    file_hash.file_size, file_hash.last_modified, file_hash.permissions,
                    file_hash.file_type, file_hash.scanned_at, file_hash.is_critical,
                    file_hash.signature
                ))

                conn.commit()

        except Exception as e:
            logger.error(f"Error storing file hash: {e}")

    def get_stored_hash(self, file_path: str) -> Optional[FileHash]:
        """Retrieve stored hash for a file"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()

                cursor.execute('SELECT * FROM file_hashes WHERE file_path = ?', (file_path,))
                row = cursor.fetchone()

                if row:
                    return FileHash(
                        file_path=row[0],
                        hash_algorithm=row[1],
                        hash_value=row[2],
                        file_size=row[3],
                        last_modified=row[4],
                        permissions=row[5],
                        file_type=row[6],
                        scanned_at=row[7],
                        is_critical=bool(row[8]),
                        signature=row[9]
                    )

        except Exception as e:
            logger.error(f"Error retrieving stored hash: {e}")

        return None

    def verify_file_integrity(self, file_path: Union[str, Path]) -> List[IntegrityCheck]:
        """Verify integrity of a single file"""
        file_path = Path(file_path)
        checks = []

        if not file_path.exists():
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='EXISTENCE',
                status='FAIL',
                details='File does not exist',
                timestamp=datetime.now().isoformat()
            ))
            return checks

        # Get stored hash
        stored_hash = self.get_stored_hash(str(file_path))

        if not stored_hash:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='HASH_AVAILABILITY',
                status='WARN',
                details='No stored hash available for comparison',
                timestamp=datetime.now().isoformat()
            ))
            return checks

        # Compute current hash
        current_hash = self.compute_file_hash(file_path, stored_hash.hash_algorithm)

        if not current_hash:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='HASH_COMPUTATION',
                status='FAIL',
                details='Failed to compute current hash',
                timestamp=datetime.now().isoformat()
            ))
            return checks

        # Compare hashes
        if current_hash.hash_value != stored_hash.hash_value:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='HASH',
                status='FAIL',
                details=f'Hash mismatch: expected {stored_hash.hash_value}, got {current_hash.hash_value}',
                timestamp=datetime.now().isoformat(),
                expected_value=stored_hash.hash_value,
                actual_value=current_hash.hash_value
            ))
        else:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='HASH',
                status='PASS',
                details='Hash verification successful',
                timestamp=datetime.now().isoformat()
            ))

        # Check file size
        if current_hash.file_size != stored_hash.file_size:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='SIZE',
                status='FAIL',
                details=f'Size mismatch: expected {stored_hash.file_size}, got {current_hash.file_size}',
                timestamp=datetime.now().isoformat(),
                expected_value=str(stored_hash.file_size),
                actual_value=str(current_hash.file_size)
            ))

        # Check permissions
        if current_hash.permissions != stored_hash.permissions:
            checks.append(IntegrityCheck(
                file_path=str(file_path),
                check_type='PERMISSION',
                status='WARN',
                details=f'Permission changed: expected {stored_hash.permissions}, got {current_hash.permissions}',
                timestamp=datetime.now().isoformat(),
                expected_value=stored_hash.permissions,
                actual_value=current_hash.permissions
            ))

        return checks

    def verify_directory_integrity(self, directory: Path) -> List[IntegrityCheck]:
        """Verify integrity of all files in a directory"""
        logger.info(f"Verifying integrity of directory: {directory}")
        all_checks = []

        # Get all stored hashes for this directory
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()

                # Get all files in the directory
                files_to_check = []
                for file_path in directory.rglob('*'):
                    # Skip excluded directories
                    if any(excluded in str(file_path) for excluded in self.excluded_dirs):
                        continue

                    if file_path.is_file():
                        files_to_check.append(file_path)

                # Check each file
                for file_path in files_to_check:
                    checks = self.verify_file_integrity(file_path)
                    all_checks.extend(checks)

                # Check for deleted files
                cursor.execute('SELECT file_path FROM file_hashes WHERE file_path LIKE ?', (f"{directory}%",))
                stored_files = [row[0] for row in cursor.fetchall()]

                for stored_file in stored_files:
                    if not Path(stored_file).exists():
                        all_checks.append(IntegrityCheck(
                            file_path=stored_file,
                            check_type='EXISTENCE',
                            status='FAIL',
                            details='File has been deleted',
                            timestamp=datetime.now().isoformat()
                        ))

        except Exception as e:
            logger.error(f"Error verifying directory integrity: {e}")

        logger.info(f"Integrity verification completed. {len(all_checks)} checks performed.")
        return all_checks

    def create_baseline(self, directory: Path, algorithm: str = 'sha256') -> int:
        """Create baseline hash database for directory"""
        logger.info(f"Creating baseline for directory: {directory}")
        hashes = self.compute_directory_hashes(directory, algorithm)

        # Store all hashes
        for file_hash in hashes:
            self.store_file_hash(file_hash)

        logger.info(f"Baseline created with {len(hashes)} files")
        return len(hashes)

    def generate_integrity_report(self, checks: List[IntegrityCheck]) -> Dict[str, Any]:
        """Generate comprehensive integrity report"""
        logger.info("Generating integrity report...")

        # Calculate summary statistics
        summary = {
            'total_checks': len(checks),
            'passed': len([c for c in checks if c.status == 'PASS']),
            'failed': len([c for c in checks if c.status == 'FAIL']),
            'warnings': len([c for c in checks if c.status == 'WARN']),
            'by_check_type': {},
            'by_severity': {
                'critical': 0,
                'high': 0,
                'medium': 0,
                'low': 0
            }
        }

        # Group by check type
        for check in checks:
            check_type = check.check_type
            if check_type not in summary['by_check_type']:
                summary['by_check_type'][check_type] = {'pass': 0, 'fail': 0, 'warn': 0}

            if check.status == 'PASS':
                summary['by_check_type'][check_type]['pass'] += 1
            elif check.status == 'FAIL':
                summary['by_check_type'][check_type]['fail'] += 1
            elif check.status == 'WARN':
                summary['by_check_type'][check_type]['warn'] += 1

            # Assess severity
            if check.status == 'FAIL':
                if check.check_type in ['HASH', 'EXISTENCE']:
                    summary['by_severity']['critical'] += 1
                elif check.check_type in ['SIZE']:
                    summary['by_severity']['high'] += 1
                elif check.check_type in ['PERMISSION']:
                    summary['by_severity']['medium'] += 1
            elif check.status == 'WARN':
                summary['by_severity']['low'] += 1

        # Calculate risk score
        critical_score = summary['by_severity']['critical'] * 10
        high_score = summary['by_severity']['high'] * 5
        medium_score = summary['by_severity']['medium'] * 2
        low_score = summary['by_severity']['low'] * 1
        risk_score = critical_score + high_score + medium_score + low_score

        risk_level = (
            'CRITICAL' if risk_score >= 50 else
            'HIGH' if risk_score >= 20 else
            'MEDIUM' if risk_score >= 10 else
            'LOW'
        )

        # Generate report
        report = {
            'timestamp': datetime.now().isoformat(),
            'project_root': str(self.project_root),
            'summary': summary,
            'risk_score': risk_score,
            'risk_level': risk_level,
            'checks': [asdict(check) for check in checks],
            'recommendations': self._generate_integrity_recommendations(checks, summary)
        }

        # Save report
        report_file = self.reports_dir / f"integrity-report-{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_file, 'w') as f:
            json.dump(report, f, indent=2)

        logger.info(f"Integrity report saved to {report_file}")
        return report

    def _generate_integrity_recommendations(self, checks: List[IntegrityCheck], summary: Dict) -> List[str]:
        """Generate recommendations based on integrity check results"""
        recommendations = []

        # Critical issues
        if summary['by_severity']['critical'] > 0:
            recommendations.append("CRITICAL: Immediate investigation required for critical integrity failures")

        # High severity issues
        if summary['by_severity']['high'] > 0:
            recommendations.append("HIGH: Address high severity integrity issues immediately")

        # File deletions
        deleted_files = [c for c in checks if c.check_type == 'EXISTENCE' and c.status == 'FAIL']
        if deleted_files:
            recommendations.append(f"{len(deleted_files)} files have been deleted - investigate unauthorized changes")

        # Hash mismatches
        hash_mismatches = [c for c in checks if c.check_type == 'HASH' and c.status == 'FAIL']
        if hash_mismatches:
            recommendations.append(f"{len(hash_mismatches)} files have hash mismatches - investigate unauthorized modifications")

        # Permission changes
        permission_changes = [c for c in checks if c.check_type == 'PERMISSION' and c.status == 'WARN']
        if permission_changes:
            recommendations.append(f"{len(permission_changes)} files have permission changes - review access controls")

        # General recommendations
        recommendations.extend([
            "Implement regular integrity monitoring in CI/CD pipeline",
            "Use file integrity monitoring (FIM) tools for real-time detection",
            "Investigate all unauthorized file changes immediately",
            "Maintain regular backups of critical files",
            "Consider using digital signatures for critical files",
            "Implement access controls and audit logging"
        ])

        return recommendations

    def monitor_file_changes(self, directory: Path, interval: int = 60, max_cycles: int = None):
        """Monitor file changes in real-time"""
        logger.info(f"Starting file change monitoring for {directory}")
        cycle = 0

        try:
            while max_cycles is None or cycle < max_cycles:
                cycle += 1
                logger.info(f"Monitoring cycle {cycle}")

                # Run integrity check
                checks = self.verify_directory_integrity(directory)

                # Filter for issues
                issues = [c for c in checks if c.status in ['FAIL', 'WARN']]

                if issues:
                    logger.warning(f"Found {len(issues)} integrity issues")
                    # Generate alert report
                    alert_report = self.generate_integrity_report(checks)
                    # Here you could send alerts, notifications, etc.

                # Wait for next cycle
                time.sleep(interval)

        except KeyboardInterrupt:
            logger.info("Monitoring stopped by user")
        except Exception as e:
            logger.error(f"Monitoring error: {e}")

def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(description="NOIP File Hasher - Integrity Verification System")
    parser.add_argument("--project-root", default="/workspaces/NOIP", help="Project root directory")
    parser.add_argument("--operation", choices=['hash', 'verify', 'baseline', 'monitor', 'report'], required=True, help="Operation to perform")
    parser.add_argument("--directory", help="Directory to process")
    parser.add_argument("--file", help="File to process")
    parser.add_argument("--algorithm", default="sha256", choices=list(hashlib.algorithms_available), help="Hash algorithm")
    parser.add_argument("--output", help="Output file for results")
    parser.add_argument("--interval", type=int, default=60, help="Monitoring interval in seconds")
    parser.add_argument("--max-cycles", type=int, help="Maximum monitoring cycles")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")

    args = parser.parse_args()

    # Set log level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Initialize file hasher
    hasher = FileHasher(args.project_root)

    if args.operation == 'hash':
        if args.file:
            file_hash = hasher.compute_file_hash(Path(args.file), args.algorithm)
            if file_hash:
                print(json.dumps(asdict(file_hash), indent=2))
            else:
                print("Failed to compute file hash")
        elif args.directory:
            hashes = hasher.compute_directory_hashes(Path(args.directory), args.algorithm)
            print(f"Computed {len(hashes)} file hashes")
            if args.output:
                with open(args.output, 'w') as f:
                    json.dump([asdict(h) for h in hashes], f, indent=2)
                print(f"Hashes saved to {args.output}")
        else:
            print("Error: --file or --directory required for hash operation")

    elif args.operation == 'verify':
        if args.file:
            checks = hasher.verify_file_integrity(Path(args.file))
            print(f"Performed {len(checks)} integrity checks")
            for check in checks:
                print(f"  {check.check_type}: {check.status} - {check.details}")
        elif args.directory:
            checks = hasher.verify_directory_integrity(Path(args.directory))
            print(f"Performed {len(checks)} integrity checks")
            report = hasher.generate_integrity_report(checks)
            print(f"Risk level: {report['risk_level']}")
            print(f"Risk score: {report['risk_score']}")
        else:
            print("Error: --file or --directory required for verify operation")

    elif args.operation == 'baseline':
        if not args.directory:
            print("Error: --directory required for baseline operation")
            sys.exit(1)

        count = hasher.create_baseline(Path(args.directory), args.algorithm)
        print(f"Baseline created with {count} files")

    elif args.operation == 'monitor':
        if not args.directory:
            print("Error: --directory required for monitor operation")
            sys.exit(1)

        print(f"Starting file change monitoring for {args.directory}")
        print(f"Interval: {args.interval} seconds")
        hasher.monitor_file_changes(Path(args.directory), args.interval, args.max_cycles)

    elif args.operation == 'report':
        if not args.directory:
            print("Error: --directory required for report operation")
            sys.exit(1)

        checks = hasher.verify_directory_integrity(Path(args.directory))
        report = hasher.generate_integrity_report(checks)
        print(json.dumps(report, indent=2))

    if args.output and args.operation != 'hash':
        with open(args.output, 'w') as f:
            json.dump(report if 'report' in locals() else {}, f, indent=2)
        print(f"Report saved to {args.output}")

if __name__ == "__main__":
    main()