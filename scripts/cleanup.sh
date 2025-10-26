#!/bin/bash

# NOIP Platform Cleanup Script
# Safe cleanup of resources with backup and confirmation

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NAMESPACE="${NAMESPACE:-noip-production}"
FORCE="${FORCE:-false}"
BACKUP_BEFORE_CLEANUP="${BACKUP_BEFORE_CLEANUP:-true}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS:${NC} $1" >&2
}

# Confirmation prompt
confirm() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi

    read -p "$1 [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        return 0
    else
        return 1
    fi
}

# Backup before cleanup
backup_before_cleanup() {
    if [[ "$BACKUP_BEFORE_CLEANUP" != "true" ]]; then
        log "Skipping backup before cleanup"
        return
    fi

    log "Creating backup before cleanup..."

    BACKUP_DIR="$PROJECT_ROOT/backups/pre-cleanup_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"

    # Backup all resources
    kubectl get all,configmaps,secrets,pvc,ingress -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/full-backup.yaml"

    # Save resource counts
    kubectl get pods -n "$NAMESPACE" --no-headers | wc -l > "$BACKUP_DIR/pod-count.txt"
    kubectl get services -n "$NAMESPACE" --no-headers | wc -l > "$BACKUP_DIR/service-count.txt"
    kubectl get deployments -n "$NAMESPACE" --no-headers | wc -l > "$BACKUP_DIR/deployment-count.txt"

    success "Backup created at $BACKUP_DIR"
}

# Cleanup application components
cleanup_application() {
    log "Cleaning up application components..."

    # Scale down deployments first
    if kubectl get deployment noip-platform -n "$NAMESPACE" &> /dev/null; then
        log "Scaling down application deployment..."
        kubectl scale deployment noip-platform --replicas=0 -n "$NAMESPACE"
        kubectl wait --for=condition=Updated deployment/noip-platform -n "$NAMESPACE" --timeout=300s
    fi

    # Delete ingress
    log "Removing ingress resources..."
    kubectl delete ingress --all -n "$NAMESPACE" --ignore-not-found=true

    # Delete services
    log "Removing application services..."
    kubectl delete service noip-platform-service noip-platform-api-service -n "$NAMESPACE" --ignore-not-found=true

    # Delete deployments
    log "Removing application deployments..."
    kubectl delete deployment noip-platform -n "$NAMESPACE" --ignore-not-found=true

    # Delete HPA and PDB
    kubectl delete hpa,pdb -l app=noip-platform -n "$NAMESPACE" --ignore-not-found=true

    success "Application components cleaned up"
}

# Cleanup databases (with data retention warning)
cleanup_databases() {
    if ! confirm "⚠️  This will delete all database components. DATA WILL BE LOST! Continue?"; then
        log "Skipping database cleanup"
        return
    fi

    log "Cleaning up database components..."

    # Delete StatefulSets
    kubectl delete statefulset mongodb redis -n "$NAMESPACE" --ignore-not-found=true

    # Delete PVCs (this will delete data!)
    if confirm "⚠️  This will permanently delete all database data. Continue?"; then
        kubectl delete pvc -l app in (mongodb,redis) -n "$NAMESPACE" --ignore-not-found=true
    fi

    # Delete headless services
    kubectl delete service mongodb-headless mongodb-service redis-service -n "$NAMESPACE" --ignore-not-found=true

    success "Database components cleaned up"
}

# Cleanup monitoring
cleanup_monitoring() {
    log "Cleaning up monitoring components..."

    # Delete monitoring namespace resources
    kubectl delete deployment,pod,service,configmap,secret --all -n noip-monitoring --ignore-not-found=true

    # Delete monitoring PVCs
    kubectl delete pvc --all -n noip-monitoring --ignore-not-found=true

    success "Monitoring components cleaned up"
}

# Cleanup security policies
cleanup_security() {
    log "Cleaning up security policies..."

    # Delete network policies
    kubectl delete networkpolicy --all -n "$NAMESPACE" --ignore-not-found=true

    # Delete RBAC resources
    kubectl delete rolebinding,role -l app=noip-platform -n "$NAMESPACE" --ignore-not-found=true

    # Delete resource quotas
    kubectl delete resourcequota,limitrange -n "$NAMESPACE" --ignore-not-found=true

    success "Security policies cleaned up"
}

# Cleanup configuration
cleanup_configuration() {
    log "Cleaning up configuration resources..."

    # Delete configmaps and secrets
    kubectl delete configmap --all -n "$NAMESPACE" --ignore-not-found=true
    kubectl delete secret --all -n "$NAMESPACE" --ignore-not-found=true

    success "Configuration resources cleaned up"
}

# Complete namespace cleanup
cleanup_namespace() {
    if ! confirm "⚠️  This will delete the entire namespace '$NAMESPACE' and all resources in it. Continue?"; then
        log "Skipping namespace cleanup"
        return
    fi

    log "Cleaning up entire namespace: $NAMESPACE"

    # Delete namespace (this will delete everything in it)
    kubectl delete namespace "$NAMESPACE" --ignore-not-found=true

    success "Namespace $NAMESPACE cleaned up"
}

# Cleanup monitoring namespace
cleanup_monitoring_namespace() {
    if ! confirm "Delete monitoring namespace 'noip-monitoring' and all resources?"; then
        log "Skipping monitoring namespace cleanup"
        return
    fi

    log "Cleaning up monitoring namespace..."

    kubectl delete namespace noip-monitoring --ignore-not-found=true

    success "Monitoring namespace cleaned up"
}

# Force cleanup (delete everything)
force_cleanup() {
    log "Performing force cleanup of all NOIP platform resources..."

    # Delete all NOIP related resources across all namespaces
    kubectl delete all,configmaps,secrets,pvc,ingress,networkpolicy \
        -l app=noip-platform \
        --all-namespaces \
        --ignore-not-found=true

    # Delete StatefulSets
    kubectl delete statefulset -l app in (mongodb,redis,noip-platform) --all-namespaces --ignore-not-found=true

    # Delete namespaces
    kubectl delete namespace noip-production noip-staging noip-monitoring --ignore-not-found=true

    success "Force cleanup completed"
}

# Show cleanup status
show_status() {
    log "Current NOIP platform resource status:"
    echo

    # Show namespaces
    echo "Namespaces:"
    kubectl get namespaces | grep noip || echo "  No NOIP namespaces found"
    echo

    # Show pods in primary namespace
    if kubectl get namespace "$NAMESPACE" &> /dev/null; then
        echo "Pods in $NAMESPACE:"
        kubectl get pods -n "$NAMESPACE" || echo "  No pods found"
        echo
    fi

    # Show monitoring
    if kubectl get namespace noip-monitoring &> /dev/null; then
        echo "Monitoring pods:"
        kubectl get pods -n noip-monitoring || echo "  No monitoring pods found"
        echo
    fi

    # Show PVCs
    echo "Persistent Volumes:"
    kubectl get pvc --all-namespaces -l app in (noip-platform,mongodb,redis,prometheus,grafana,alertmanager) || echo "  No NOIP PVCs found"
    echo

    # Show services
    echo "Services:"
    kubectl get svc --all-namespaces -l app in (noip-platform,mongodb,redis,prometheus,grafana,alertmanager) || echo "  No NOIP services found"
}

# Main cleanup function
main() {
    log "Starting NOIP platform cleanup..."
    log "Namespace: $NAMESPACE"
    log "Force mode: $FORCE"

    # Show current status
    show_status

    # Create backup before cleanup
    backup_before_cleanup

    # Perform cleanup steps
    cleanup_application
    cleanup_databases
    cleanup_monitoring
    cleanup_security
    cleanup_configuration

    # Ask about namespace cleanup
    if confirm "Clean up namespaces as well?"; then
        cleanup_namespace
        cleanup_monitoring_namespace
    fi

    # Show final status
    echo
    log "Final cleanup status:"
    show_status

    success "NOIP platform cleanup completed!"

    log ""
    log "To restore from backup:"
    log "kubectl apply -f $BACKUP_DIR/full-backup.yaml"
}

# Handle script arguments
case "${1:-}" in
    "application")
        cleanup_application
        ;;
    "databases")
        cleanup_databases
        ;;
    "monitoring")
        cleanup_monitoring
        ;;
    "security")
        cleanup_security
        ;;
    "configuration")
        cleanup_configuration
        ;;
    "namespace")
        cleanup_namespace
        ;;
    "monitoring-namespace")
        cleanup_monitoring_namespace
        ;;
    "force")
        force_cleanup
        ;;
    "status")
        show_status
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  application        Clean up application components only"
        echo "  databases          Clean up database components (data loss warning)"
        echo "  monitoring         Clean up monitoring components"
        echo "  security           Clean up security policies"
        echo "  configuration      Clean up configuration resources"
        echo "  namespace          Clean up entire namespace (destructive)"
        echo "  monitoring-namespace Clean up monitoring namespace"
        echo "  force              Force cleanup of all NOIP resources"
        echo "  status             Show current resource status"
        echo "  help               Show this help message"
        echo ""
        echo "Environment variables:"
        echo "  NAMESPACE           Kubernetes namespace (default: noip-production)"
        echo "  FORCE               Skip confirmation prompts (default: false)"
        echo "  BACKUP_BEFORE_CLEANUP Create backup before cleanup (default: true)"
        echo ""
        echo "⚠️  WARNING: This script will permanently delete resources!"
        echo "    Always review the status command before running cleanup."
        ;;
    "")
        main
        ;;
    *)
        error "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac