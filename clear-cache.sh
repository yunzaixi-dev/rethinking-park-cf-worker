#!/bin/bash

# ReThinking Park - Cache Management Script
# Quick utility to manage the API cache

API_BASE="https://api.rethinkingpark.com/api/v1"

echo "🗑️  ReThinking Park Cache Management"
echo "=================================="

# Function to make API call and format output
call_api() {
    local endpoint="$1"
    echo "📡 Calling: $endpoint"
    echo ""
    curl -s "$endpoint" | jq
    echo ""
}

case "${1:-help}" in
    "clear")
        echo "🧹 Clearing all cache entries..."
        call_api "$API_BASE/cache?action=clear"
        ;;
    
    "size"|"status")
        echo "📊 Checking cache size and entries..."
        call_api "$API_BASE/cache?action=size"
        ;;
    
    "health")
        echo "🏥 Checking system health and cache config..."
        call_api "$API_BASE/health"
        ;;
    
    "delete")
        if [ -z "$2" ]; then
            echo "❌ Error: Hash prefix required for delete"
            echo "Usage: $0 delete <hash_prefix>"
            exit 1
        fi
        echo "🗑️ Deleting cache entry with hash prefix: $2"
        call_api "$API_BASE/cache?action=delete&hash=$2"
        ;;
    
    "help"|*)
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  clear     - Clear all cache entries"
        echo "  size      - Show cache size and entries" 
        echo "  health    - Show system health and cache config"
        echo "  delete    - Delete specific cache entry by hash prefix"
        echo "  help      - Show this help message"
        echo ""
        echo "Examples:"
        echo "  $0 clear"
        echo "  $0 size"
        echo "  $0 delete 63ea21dd"
        echo "  $0 health"
        ;;
esac