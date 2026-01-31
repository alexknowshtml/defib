#!/bin/bash
# defib integration tests
# Runs simulated failure scenarios to verify detection and recovery

# Don't exit on first error - we want to run all tests
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFIB="bun run $SCRIPT_DIR/../defib.ts"
COMPOSE_DIR="$SCRIPT_DIR"
STATE_FILE="/tmp/defib-test-state-$$.json"

# Auto-detect docker or podman
if command -v docker &> /dev/null; then
    COMPOSE="docker-compose"
elif command -v podman &> /dev/null; then
    COMPOSE="podman-compose"
else
    echo "Error: Neither docker nor podman found"
    exit 1
fi

echo "Using: $COMPOSE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

passed=0
failed=0

cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    cd "$COMPOSE_DIR"
    $COMPOSE down --remove-orphans 2>/dev/null || true
    rm -f "$STATE_FILE"
    # Kill any leftover test processes
    pkill -f "defib-test-hog" 2>/dev/null || true
}

trap cleanup EXIT

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((passed++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((failed++))
}

echo "============================================"
echo "defib Integration Tests"
echo "============================================"
echo ""

# ============================================
# Test 1: Pattern validation - reject dangerous patterns
# ============================================
echo -e "\n${YELLOW}Test 1: Security - reject dangerous patterns${NC}"

output=$($DEFIB processes --safe-to-kill "node" --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "Dangerous.*pattern"; then
    pass "Dangerous pattern 'node' correctly rejected"
else
    fail "Dangerous pattern not rejected"
    echo "Output: $output"
fi

# ============================================
# Test 2: Pattern validation - reject empty patterns
# ============================================
echo -e "\n${YELLOW}Test 2: Security - reject empty patterns${NC}"

output=$($DEFIB processes --safe-to-kill "" --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "at least 3 characters"; then
    pass "Empty pattern correctly rejected"
else
    fail "Empty pattern not rejected"
    echo "Output: $output"
fi

# ============================================
# Test 3: Path validation - reject shell metacharacters
# ============================================
echo -e "\n${YELLOW}Test 3: Security - reject malicious paths${NC}"

output=$($DEFIB container --health http://localhost:8080 --compose-dir "/tmp; rm -rf /" --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "shell metacharacters"; then
    pass "Path with shell metacharacters correctly rejected"
else
    fail "Malicious path not rejected"
    echo "Output: $output"
fi

# ============================================
# Test 4: Path validation - require absolute paths
# ============================================
echo -e "\n${YELLOW}Test 4: Security - require absolute paths${NC}"

output=$($DEFIB container --health http://localhost:8080 --compose-dir "./relative/path" --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "must be an absolute path"; then
    pass "Relative path correctly rejected"
else
    fail "Relative path not rejected"
    echo "Output: $output"
fi

# ============================================
# Test 5: Process monitoring runs
# ============================================
echo -e "\n${YELLOW}Test 5: Process monitoring${NC}"

output=$($DEFIB processes --ignore "bun" --ignore "node" --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "defib processes"; then
    pass "Process monitoring runs successfully"
else
    fail "Process monitoring failed"
    echo "Output: $output"
fi

# ============================================
# Test 6: System monitoring runs
# ============================================
echo -e "\n${YELLOW}Test 6: System monitoring${NC}"

output=$($DEFIB system --swap-threshold 99 --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "defib system"; then
    pass "System monitoring runs successfully"
else
    fail "System monitoring failed"
    echo "Output: $output"
fi

# ============================================
# Test 7: Dismiss command
# ============================================
echo -e "\n${YELLOW}Test 7: Dismiss command${NC}"

output=$($DEFIB dismiss 99999 --state-file "$STATE_FILE" 2>&1) || true

if echo "$output" | grep -q "Dismissed alerts for PID 99999"; then
    pass "Dismiss command works"
else
    fail "Dismiss command failed"
    echo "Output: $output"
fi

# Verify state was updated
if grep -q "99999" "$STATE_FILE"; then
    pass "Dismiss persisted to state file"
else
    fail "Dismiss not persisted"
fi

# ============================================
# Test 8: State file permissions (if on Linux)
# ============================================
echo -e "\n${YELLOW}Test 8: State file security${NC}"

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    perms=$(stat -c %a "$STATE_FILE" 2>/dev/null || echo "unknown")
    if [ "$perms" = "600" ]; then
        pass "State file has secure permissions (600)"
    else
        fail "State file permissions are $perms, expected 600"
    fi
else
    pass "Skipped on non-Linux (permissions test)"
fi

# ============================================
# Container tests (optional - require compose)
# ============================================
echo -e "\n${YELLOW}Test 9: Container health detection (optional)${NC}"

# Check if compose is working
if $COMPOSE version &>/dev/null; then
    cd "$COMPOSE_DIR"

    # Build and start healthy container
    $COMPOSE build healthy 2>/dev/null || { fail "Could not build test container"; }
    $COMPOSE up -d healthy 2>/dev/null
    sleep 3

    output=$($DEFIB container --health http://localhost:18080 --compose-dir "$COMPOSE_DIR" --state-file "$STATE_FILE" 2>&1) || true

    if echo "$output" | grep -q "Container healthy"; then
        pass "Healthy container detected correctly"
    else
        fail "Healthy container not detected"
        echo "Output: $output"
    fi

    $COMPOSE stop healthy 2>/dev/null
else
    pass "Skipped (compose not available)"
fi

# ============================================
# Results
# ============================================
echo ""
echo "============================================"
echo "Results: $passed passed, $failed failed"
echo "============================================"

if [ $failed -gt 0 ]; then
    exit 1
fi
