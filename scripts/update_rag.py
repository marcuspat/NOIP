# scripts/update_rag.py
#!/usr/bin/env python3
"""
NetOps Intelligence Platform - RAG Update Module

This module handles the ingestion and management of infrastructure data
into a Retrieval-Augmented Generation (RAG) system for intelligent
infrastructure analysis and querying.

Author: NOIP Team
Version: 1.0.0
"""

import json
import hashlib
import logging
import sys
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
import chromadb
from chromadb.config import Settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('rag_update.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class RAGUpdateError(Exception):
    """Custom exception for RAG update operations"""
    pass

class InfrastructureRAG:
    """
    Manages infrastructure data ingestion and querying using RAG.

    Features:
    - Automatic data validation and cleaning
    - Duplicate detection and management
    - Metadata extraction and indexing
    - Query capabilities with relevance scoring
    """

    def __init__(self, persist_dir: str = "./rag", collection_name: str = "infrastructure"):
        """
        Initialize the RAG system.

        Args:
            persist_dir: Directory to persist the RAG database
            collection_name: Name of the collection to use/create
        """
        self.persist_dir = Path(persist_dir)
        self.collection_name = collection_name

        try:
            # Initialize ChromaDB client
            self.client = chromadb.Client(Settings(
                chroma_db_impl="duckdb+parquet",
                persist_directory=str(self.persist_dir)
            ))

            # Create or get collection
            self.collection = self.client.get_or_create_collection(
                name=self.collection_name,
                metadata={"hnsw:space": "cosine"}
            )

            logger.info(f"RAG system initialized with collection '{self.collection_name}'")

        except Exception as e:
            logger.error(f"Failed to initialize RAG system: {e}")
            raise RAGUpdateError(f"RAG initialization failed: {e}")

    def validate_json_data(self, data: Dict[str, Any], file_path: str) -> bool:
        """
        Validate JSON data structure and content.

        Args:
            data: Parsed JSON data
            file_path: Source file path for logging

        Returns:
            bool: True if valid, False otherwise
        """
        try:
            # Basic structure validation
            if not isinstance(data, dict):
                logger.warning(f"Invalid data structure in {file_path}: not a dictionary")
                return False

            # Check for required fields based on file type
            if "kubernetes" in file_path.lower():
                required_fields = ["scan_timestamp", "cluster_info"]
            elif "security" in file_path.lower():
                required_fields = ["scan_timestamp", "summary"]
            elif "drift" in file_path.lower():
                required_fields = ["scan_timestamp", "total_resources"]
            else:
                required_fields = ["scan_timestamp"]  # Basic requirement

            missing_fields = [field for field in required_fields if field not in data]
            if missing_fields:
                logger.warning(f"Missing required fields in {file_path}: {missing_fields}")
                return False

            # Validate timestamp format
            if "scan_timestamp" in data:
                try:
                    datetime.fromisoformat(data["scan_timestamp"].replace('Z', '+00:00'))
                except (ValueError, AttributeError):
                    logger.warning(f"Invalid timestamp format in {file_path}")
                    return False

            logger.debug(f"Data validation passed for {file_path}")
            return True

        except Exception as e:
            logger.error(f"Validation error for {file_path}: {e}")
            return False

    def generate_content_hash(self, data: Dict[str, Any]) -> str:
        """
        Generate a consistent hash for data content.

        Args:
            data: JSON data to hash

        Returns:
            str: SHA256 hash (first 16 characters)
        """
        try:
            # Sort keys for consistent hashing
            normalized_data = json.dumps(data, sort_keys=True, default=str)
            return hashlib.sha256(normalized_data.encode()).hexdigest()[:16]
        except Exception as e:
            logger.error(f"Hash generation failed: {e}")
            raise RAGUpdateError(f"Hash generation failed: {e}")

    def extract_metadata(self, data: Dict[str, Any], file_path: Path) -> Dict[str, Any]:
        """
        Extract rich metadata from infrastructure data.

        Args:
            data: Parsed JSON data
            file_path: Source file path

        Returns:
            Dict: Extracted metadata
        """
        try:
            metadata = {
                "source": str(file_path),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": file_path.parent.name,
                "filename": file_path.name,
                "size_bytes": len(json.dumps(data, default=str).encode()),
                "ingested_at": datetime.now(timezone.utc).isoformat()
            }

            # Extract type-specific metadata
            if "kubernetes" in file_path.name.lower():
                metadata.update({
                    "infrastructure_type": "kubernetes",
                    "cluster_name": data.get("cluster_info", {}).get("name", "unknown"),
                    "node_count": data.get("cluster_info", {}).get("nodes", 0),
                    "pod_count": data.get("cluster_info", {}).get("pods", 0)
                })
            elif "security" in file_path.name.lower():
                metadata.update({
                    "infrastructure_type": "security",
                    "total_findings": data.get("summary", {}).get("total_findings", 0),
                    "critical_issues": data.get("summary", {}).get("critical", 0),
                    "high_issues": data.get("summary", {}).get("high", 0)
                })
            elif "drift" in file_path.name.lower():
                metadata.update({
                    "infrastructure_type": "drift",
                    "total_resources": data.get("total_resources", 0),
                    "drifted_resources": data.get("drifted_resources", 0),
                    "drift_percentage": data.get("drift_percentage", 0.0)
                })

            return metadata

        except Exception as e:
            logger.error(f"Metadata extraction failed for {file_path}: {e}")
            return {
                "source": str(file_path),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": file_path.parent.name,
                "error": f"Metadata extraction failed: {e}"
            }

    def check_duplicate_content(self, doc_id: str, data: Dict[str, Any]) -> bool:
        """
        Check if content already exists in the collection.

        Args:
            doc_id: Document ID to check
            data: Data to compare against existing content

        Returns:
            bool: True if duplicate exists
        """
        try:
            # Check if document exists
            existing_docs = self.collection.get(ids=[doc_id])

            if existing_docs['ids']:
                # Compare content to detect actual duplicates vs same ID
                new_content = json.dumps(data, sort_keys=True, default=str)
                existing_content = existing_docs['documents'][0]

                if new_content == existing_content:
                    logger.debug(f"Duplicate content detected for ID: {doc_id}")
                    return True
                else:
                    logger.info(f"Content changed for ID: {doc_id}, updating...")
                    return False

            return False

        except Exception as e:
            logger.error(f"Duplicate check failed for {doc_id}: {e}")
            return False

    def update_inventory(self, inventory_path: str, recursive: bool = True) -> Dict[str, Any]:
        """
        Update RAG with latest infrastructure inventory.

        Args:
            inventory_path: Path to inventory directory
            recursive: Whether to search subdirectories

        Returns:
            Dict: Update statistics and results
        """
        inventory_dir = Path(inventory_path)
        if not inventory_dir.exists():
            logger.error(f"Inventory directory does not exist: {inventory_dir}")
            raise RAGUpdateError(f"Inventory directory not found: {inventory_dir}")

        logger.info(f"Starting RAG update from: {inventory_dir}")

        # Statistics
        stats = {
            "total_files": 0,
            "successful_updates": 0,
            "skipped_files": 0,
            "errors": 0,
            "duplicates_found": 0,
            "start_time": datetime.now(timezone.utc).isoformat(),
            "updated_files": [],
            "skipped_list": [],
            "error_list": []
        }

        # Find JSON files
        pattern = "**/*.json" if recursive else "*.json"
        json_files = list(inventory_dir.glob(pattern))
        stats["total_files"] = len(json_files)

        logger.info(f"Found {len(json_files)} JSON files to process")

        for json_file in json_files:
            try:
                logger.info(f"Processing: {json_file.name}")

                # Load and validate data
                with open(json_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)

                if not self.validate_json_data(data, str(json_file)):
                    stats["skipped_files"] += 1
                    stats["skipped_list"].append({
                        "file": str(json_file),
                        "reason": "validation_failed"
                    })
                    continue

                # Generate document ID
                doc_id = self.generate_content_hash(data)

                # Check for duplicates
                if self.check_duplicate_content(doc_id, data):
                    stats["duplicates_found"] += 1
                    stats["skipped_files"] += 1
                    stats["skipped_list"].append({
                        "file": str(json_file),
                        "reason": "duplicate_content"
                    })
                    continue

                # Extract metadata
                metadata = self.extract_metadata(data, json_file)

                # Prepare document content
                document_content = json.dumps(data, indent=2, default=str)

                # Add to collection (update if exists)
                if self.collection.get(ids=[doc_id])['ids']:
                    self.collection.update(
                        ids=[doc_id],
                        documents=[document_content],
                        metadatas=[metadata]
                    )
                    logger.debug(f"Updated existing document: {doc_id}")
                else:
                    self.collection.add(
                        documents=[document_content],
                        metadatas=[metadata],
                        ids=[doc_id]
                    )
                    logger.debug(f"Added new document: {doc_id}")

                stats["successful_updates"] += 1
                stats["updated_files"].append(str(json_file))

            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error in {json_file}: {e}")
                stats["errors"] += 1
                stats["error_list"].append({
                    "file": str(json_file),
                    "error": f"JSON decode error: {e}"
                })

            except Exception as e:
                logger.error(f"Error processing {json_file}: {e}")
                stats["errors"] += 1
                stats["error_list"].append({
                    "file": str(json_file),
                    "error": str(e)
                })

        # Finalize statistics
        stats["end_time"] = datetime.now(timezone.utc).isoformat()
        stats["total_documents"] = len(self.collection.get()['ids'])

        # Log summary
        logger.info(f"RAG update completed:")
        logger.info(f"  - Total files processed: {stats['total_files']}")
        logger.info(f"  - Successful updates: {stats['successful_updates']}")
        logger.info(f"  - Skipped files: {stats['skipped_files']} (duplicates: {stats['duplicates_found']})")
        logger.info(f"  - Errors: {stats['errors']}")
        logger.info(f"  - Total documents in collection: {stats['total_documents']}")

        return stats

    def query_infrastructure(self, query: str, n_results: int = 5,
                           filter_metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Query infrastructure knowledge base.

        Args:
            query: Search query string
            n_results: Number of results to return
            filter_metadata: Optional metadata filters

        Returns:
            Dict: Query results with metadata
        """
        try:
            logger.info(f"Querying RAG with: '{query}' (n_results={n_results})")

            results = self.collection.query(
                query_texts=[query],
                n_results=n_results,
                where=filter_metadata
            )

            # Enhance results with additional metadata
            enhanced_results = {
                "query": query,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total_results": len(results['ids'][0]) if results['ids'] else 0,
                "results": []
            }

            for i, doc_id in enumerate(results['ids'][0] if results['ids'] else []):
                result = {
                    "id": doc_id,
                    "document": results['documents'][0][i] if results['documents'] else None,
                    "metadata": results['metadatas'][0][i] if results['metadatas'] else {},
                    "distance": results['distances'][0][i] if results['distances'] else None
                }
                enhanced_results["results"].append(result)

            logger.info(f"Query returned {enhanced_results['total_results']} results")
            return enhanced_results

        except Exception as e:
            logger.error(f"Query failed: {e}")
            raise RAGUpdateError(f"Query failed: {e}")

    def get_collection_stats(self) -> Dict[str, Any]:
        """
        Get statistics about the current collection.

        Returns:
            Dict: Collection statistics
        """
        try:
            all_docs = self.collection.get()

            # Count by infrastructure type
            type_counts = {}
            for metadata in all_docs['metadatas'] or []:
                infra_type = metadata.get('infrastructure_type', 'unknown')
                type_counts[infra_type] = type_counts.get(infra_type, 0) + 1

            return {
                "total_documents": len(all_docs['ids']) if all_docs['ids'] else 0,
                "infrastructure_types": type_counts,
                "collection_name": self.collection_name,
                "persist_directory": str(self.persist_dir),
                "timestamp": datetime.now(timezone.utc).isoformat()
            }

        except Exception as e:
            logger.error(f"Failed to get collection stats: {e}")
            return {"error": str(e)}

    def clear_collection(self, confirmation: bool = False) -> bool:
        """
        Clear all documents from the collection.

        Args:
            confirmation: Must be True to proceed

        Returns:
            bool: True if successful
        """
        if not confirmation:
            logger.warning("Collection clear requires confirmation=True")
            return False

        try:
            # Get current count for logging
            current_count = len(self.collection.get()['ids'])
            logger.info(f"Clearing {current_count} documents from collection")

            # Delete and recreate collection
            self.client.delete_collection(self.collection_name)
            self.collection = self.client.get_or_create_collection(
                name=self.collection_name,
                metadata={"hnsw:space": "cosine"}
            )

            logger.info(f"Collection cleared and recreated")
            return True

        except Exception as e:
            logger.error(f"Failed to clear collection: {e}")
            return False

def main():
    """Main entry point for RAG update script."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Update NOIP RAG database with infrastructure data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python update_rag.py inventory/
  python update_rag.py inventory/ --recursive
  python update_rag.py inventory/ --query "security issues"
  python update_rag.py inventory/ --stats
  python update_rag.py inventory/ --clear-collection
"""
    )

    parser.add_argument(
        "inventory_path",
        help="Path to inventory directory containing JSON files"
    )
    parser.add_argument(
        "--recursive", "-r",
        action="store_true",
        default=True,
        help="Search subdirectories recursively (default: True)"
    )
    parser.add_argument(
        "--no-recursive",
        action="store_true",
        help="Do not search subdirectories recursively"
    )
    parser.add_argument(
        "--query", "-q",
        help="Query the RAG database after update"
    )
    parser.add_argument(
        "--n-results", "-n",
        type=int,
        default=5,
        help="Number of results for queries (default: 5)"
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show collection statistics"
    )
    parser.add_argument(
        "--persist-dir", "-p",
        default="./rag",
        help="RAG persistence directory (default: ./rag)"
    )
    parser.add_argument(
        "--collection-name", "-c",
        default="infrastructure",
        help="Collection name (default: infrastructure)"
    )
    parser.add_argument(
        "--clear-collection",
        action="store_true",
        help="Clear all documents from collection (requires confirmation)"
    )
    parser.add_argument(
        "--log-level",
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        default='INFO',
        help="Logging level (default: INFO)"
    )

    args = parser.parse_args()

    # Set log level
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    try:
        # Initialize RAG system
        rag = InfrastructureRAG(
            persist_dir=args.persist_dir,
            collection_name=args.collection_name
        )

        # Handle clear collection
        if args.clear_collection:
            print("⚠️  This will clear all documents from the collection.")
            confirm = input("Type 'yes' to confirm: ")
            if confirm.lower() == 'yes':
                if rag.clear_collection(confirmation=True):
                    print("✅ Collection cleared successfully")
                else:
                    print("❌ Failed to clear collection")
                    sys.exit(1)
            else:
                print("Operation cancelled")
                sys.exit(0)

        # Handle stats only
        if args.stats:
            stats = rag.get_collection_stats()
            print("\n📊 Collection Statistics:")
            print(f"Total Documents: {stats.get('total_documents', 0)}")
            print(f"Collection Name: {stats.get('collection_name', 'unknown')}")
            print(f"Persist Directory: {stats.get('persist_directory', 'unknown')}")

            if 'infrastructure_types' in stats:
                print("\n📋 Infrastructure Types:")
                for infra_type, count in stats['infrastructure_types'].items():
                    print(f"  - {infra_type}: {count}")

            if 'error' in stats:
                print(f"\n❌ Error: {stats['error']}")
                sys.exit(1)

            sys.exit(0)

        # Update inventory
        recursive = args.recursive and not args.no_recursive
        print(f"🔧 Starting RAG update from: {args.inventory_path}")
        print(f"📁 Recursive search: {recursive}")

        stats = rag.update_inventory(args.inventory_path, recursive=recursive)

        # Display results
        print(f"\n📊 Update Results:")
        print(f"✅ Successfully updated: {stats['successful_updates']} files")
        print(f"⏭️  Skipped files: {stats['skipped_files']}")
        print(f"❌ Errors: {stats['errors']}")
        print(f"📈 Total documents: {stats['total_documents']}")

        if stats['error_list']:
            print(f"\n❌ Error Details:")
            for error in stats['error_list'][:5]:  # Show first 5 errors
                print(f"  - {error['file']}: {error['error']}")
            if len(stats['error_list']) > 5:
                print(f"  ... and {len(stats['error_list']) - 5} more errors")

        # Handle query
        if args.query:
            print(f"\n🔍 Query: '{args.query}'")
            results = rag.query_infrastructure(args.query, n_results=args.n_results)

            print(f"📋 Found {results['total_results']} results:")
            for i, result in enumerate(results['results'], 1):
                metadata = result['metadata']
                print(f"\n{i}. {metadata.get('filename', 'Unknown file')}")
                print(f"   Type: {metadata.get('infrastructure_type', 'Unknown')}")
                print(f"   Distance: {result.get('distance', 'N/A'):.4f}")
                if metadata.get('cluster_name'):
                    print(f"   Cluster: {metadata['cluster_name']}")

        print(f"\n✨ RAG update completed successfully!")

    except KeyboardInterrupt:
        print("\n⚠️  Operation interrupted by user")
        sys.exit(1)
    except RAGUpdateError as e:
        print(f"\n❌ RAG Update Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        logger.exception("Unexpected error in main")
        sys.exit(1)

if __name__ == "__main__":
    main()
