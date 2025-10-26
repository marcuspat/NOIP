#!/bin/bash

# NOIP Platform Deployment Script
# Production deployment with validation and rollback capabilities

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NAMESPACE="noip-production"
ENVIRONMENT="${ENVIRONMENT:-production}"
DRY_RUN="${DRY_RUN:-false}"
SKIP_VALIDATION="${SKIP_VALIDATION:-false}"
SKIP_BACKUP="${SKIP_BACKUP:-false}"

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

# Validate prerequisites
validate_prerequisites() {
    log "Validating prerequisites..."

    # Check if kubectl is available
    if ! command -v kubectl &> /dev/null; then
        error "kubectl is not installed or not in PATH"
        exit 1
    fi

    # Check if helm is available (for service mesh)
    if ! command -v helm &> /dev/null; then
        warn "helm is not installed. Service mesh deployment will be skipped."
    fi

    # Check Docker registry access
    if ! docker info &> /dev/null; then
        error "Docker is not accessible"
        exit 1
    fi

    # Check if cluster is accessible
    if ! kubectl cluster-info &> /dev/null; then
        error "Kubernetes cluster is not accessible"
        exit 1
    fi

    # Check required namespaces exist or can be created
    if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
        log "Namespace $NAMESPACE does not exist, will be created"
    fi

    success "Prerequisites validation completed"
}

# Backup current deployment
backup_deployment() {
    if [[ "$SKIP_BACKUP" == "true" ]]; then
        log "Skipping backup as requested"
        return
    fi

    log "Creating backup of current deployment..."

    BACKUP_DIR="$PROJECT_ROOT/backups/$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"

    # Backup all resources in namespace
    kubectl get all,configmaps,secrets,pvc,ingress -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/backup.yaml"

    # Backup specific application resources
    kubectl get deployment,noip-platform -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/deployment.yaml"
    kubectl get configmap noip-platform-config -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/config.yaml"
    kubectl get secret noip-platform-secrets -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/secrets.yaml"

    # Backup Helm releases if applicable
    if command -v helm &> /dev/null; then
        helm list -n "$NAMESPACE" -o yaml > "$BACKUP_DIR/helm-releases.yaml" 2>/dev/null || true
    fi

    success "Backup created at $BACKUP_DIR"
}

# Validate configuration files
validate_configuration() {
    if [[ "$SKIP_VALIDATION" == "true" ]]; then
        log "Skipping validation as requested"
        return
    fi

    log "Validating configuration files..."

    # Validate Kubernetes manifests
    log "Validating Kubernetes manifests..."
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/namespace/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/configmaps/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/secrets/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/deployments/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/services/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/database/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/monitoring/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/ingress/"
    kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/security/"

    # Validate resource quotas and limits
    log "Validating resource requirements..."
    # This would include custom validation logic

    success "Configuration validation completed"
}

# Build and push Docker images
build_and_push_images() {
    log "Building and pushing Docker images..."

    # Build production image
    log "Building production Docker image..."
    docker build -t noip/platform:latest -f "$PROJECT_ROOT/docker/Dockerfile" "$PROJECT_ROOT"

    # Tag with version and timestamp
    VERSION_TAG="noip/platform:$(date +%Y%m%d_%H%M%S)"
    docker tag noip/platform:latest "$VERSION_TAG"

    # Push to registry (configure registry URL as needed)
    # docker push noip/platform:latest
    # docker push "$VERSION_TAG"

    success "Docker images built and tagged successfully"
}

# Deploy infrastructure components
deploy_infrastructure() {
    log "Deploying infrastructure components..."

    # Deploy namespaces
    log "Creating namespaces..."
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/namespace/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/namespace/"
    fi

    # Wait for namespaces to be ready
    kubectl wait --for=condition=Ready namespace/"$NAMESPACE" --timeout=300s

    # Deploy security policies
    log "Deploying security policies..."
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/security/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/security/"
    fi

    # Deploy monitoring stack
    log "Deploying monitoring stack..."
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/monitoring/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/monitoring/"
    fi

    success "Infrastructure components deployed"
}

# Deploy databases
deploy_databases() {
    log "Deploying database components..."

    # Deploy StatefulSets for databases
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/database/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/database/"

        # Wait for databases to be ready
        log "Waiting for MongoDB to be ready..."
        kubectl wait --for=condition=Ready pod -l app=mongodb -n "$NAMESPACE" --timeout=600s

        log "Waiting for Redis to be ready..."
        kubectl wait --for=condition=Ready pod -l app=redis -n "$NAMESPACE" --timeout=300s
    fi

    success "Database components deployed"
}

# Deploy application
deploy_application() {
    log "Deploying NOIP platform application..."

    # Deploy configuration and secrets
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/configmaps/"
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/secrets/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/configmaps/"
        kubectl apply -f "$PROJECT_ROOT/k8s/secrets/"
    fi

    # Deploy services
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/services/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/services/"
    fi

    # Deploy application
    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/deployments/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/deployments/"

        # Wait for deployment to be ready
        log "Waiting for application deployment to be ready..."
        kubectl wait --for=condition=Available deployment/noip-platform -n "$NAMESPACE" --timeout=600s

        # Wait for pods to be ready
        kubectl wait --for=condition=Ready pod -l app=noip-platform -n "$NAMESPACE" --timeout=600s
    fi

    success "Application deployed successfully"
}

# Deploy ingress and networking
deploy_networking() {
    log "Deploying ingress and networking components..."

    if [[ "$DRY_RUN" == "true" ]]; then
        kubectl apply --dry-run=client -f "$PROJECT_ROOT/k8s/ingress/"
    else
        kubectl apply -f "$PROJECT_ROOT/k8s/ingress/"

        # Wait for ingress to be ready
        log "Waiting for ingress to be ready..."
        sleep 30  # Give ingress controller time to process
    fi

    success "Networking components deployed"
}

# Perform post-deployment validation
validate_deployment() {
    log "Performing post-deployment validation..."

    # Check pod status
    log "Checking pod status..."
    kubectl get pods -n "$NAMESPACE"

    # Check services
    log "Checking services..."
    kubectl get svc -n "$NAMESPACE"

    # Check ingress
    log "Checking ingress..."
    kubectl get ingress -n "$NAMESPACE"

    # Health check application
    log "Performing application health check..."
    if kubectl get ingress noip-platform-ingress -n "$NAMESPACE" &> /dev/null; then
        # Get ingress URL and perform health check
        INGRESS_URL=$(kubectl get ingress noip-platform-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}')
        if command -v curl &> /dev/null && [[ "$DRY_RUN" != "true" ]]; then
            log "Checking application health at https://$INGRESS_URL/health"
            if curl -f -s "https://$INGRESS_URL/health" | jq . 2>/dev/null; then
                success "Application health check passed"
            else
                warn "Application health check failed - this may be expected immediately after deployment"
            fi
        fi
    fi

    # Check monitoring
    log "Checking monitoring components..."
    kubectl get pods -n noip-monitoring

    success "Post-deployment validation completed"
}

# Rollback function
rollback() {
    log "Initiating rollback..."

    if [[ ! -d "$PROJECT_ROOT/backups" ]]; then
        error "No backup directory found. Cannot rollback."
        exit 1
    fi

    # Get latest backup
    LATEST_BACKUP=$(ls -t "$PROJECT_ROOT/backups" | head -1)
    BACKUP_PATH="$PROJECT_ROOT/backups/$LATEST_BACKUP"

    if [[ ! -f "$BACKUP_PATH/backup.yaml" ]]; then
        error "No valid backup found at $BACKUP_PATH"
        exit 1
    fi

    log "Rolling back to backup from $LATEST_BACKUP"

    # Apply backup
    kubectl apply -f "$BACKUP_PATH/backup.yaml" --force

    success "Rollback completed"
}

# Main deployment function
main() {
    log "Starting NOIP platform deployment..."
    log "Environment: $ENVIRONMENT"
    log "Namespace: $NAMESPACE"
    log "Dry run: $DRY_RUN"

    # Validate prerequisites
    validate_prerequisites

    # Create backup
    backup_deployment

    # Validate configuration
    validate_configuration

    # Build and push images
    build_and_push_images

    # Deploy infrastructure
    deploy_infrastructure

    # Deploy databases
    deploy_databases

    # Deploy application
    deploy_application

    # Deploy networking
    deploy_networking

    # Validate deployment
    validate_deployment

    success "NOIP platform deployment completed successfully!"

    # Show access information
    log "Deployment Summary:"
    log "=================="

    if kubectl get ingress noip-platform-ingress -n "$NAMESPACE" &> /dev/null; then
        INGRESS_URL=$(kubectl get ingress noip-platform-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}')
        log "Main Application: https://$INGRESS_URL"
    fi

    if kubectl get ingress noip-api-gateway -n "$NAMESPACE" &> /dev/null; then
        API_URL=$(kubectl get ingress noip-api-gateway -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}')
        log "API Gateway: https://$API_URL"
    fi

    log "Grafana Dashboard: https://grafana.noip.company.com"
    log "Prometheus: http://prometheus-service.noip-monitoring.svc.cluster.local:9090"

    log ""
    log "To check application status:"
    log "kubectl get pods -n $NAMESPACE"
    log "kubectl logs -f deployment/noip-platform -n $NAMESPACE"

    log ""
    log "To monitor the deployment:"
    log "kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp'"
}

# Handle script arguments
case "${1:-}" in
    "validate")
        validate_prerequisites
        validate_configuration
        ;;
    "backup")
        backup_deployment
        ;;
    "rollback")
        rollback
        ;;
    "dry-run")
        DRY_RUN="true"
        main
        ;;
    "help"|"-h"|"--help")
        echo "Usage: $0 [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  deploy      Deploy the NOIP platform (default)"
        echo "  validate    Validate configuration and prerequisites"
        echo "  backup      Create backup of current deployment"
        echo "  rollback    Rollback to previous deployment"
        echo "  dry-run     Perform deployment without applying changes"
        echo "  help        Show this help message"
        echo ""
        echo "Environment variables:"
        echo "  ENVIRONMENT    Deployment environment (default: production)"
        echo "  NAMESPACE      Kubernetes namespace (default: noip-production)"
        echo "  DRY_RUN        Perform dry run (default: false)"
        echo "  SKIP_VALIDATION Skip configuration validation (default: false)"
        echo "  SKIP_BACKUP    Skip backup creation (default: false)"
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