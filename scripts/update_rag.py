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
