#!/bin/bash
# git-smart-stage.sh - Non-interactive partial staging for AI agents
#
# This script enables AI agents to perform partial staging (like git add -p)
# without requiring interactive input. It uses patchutils (filterdiff) to
# extract specific hunks from diffs and apply them to the staging area.
#
# Requirements:
#   - patchutils (provides: filterdiff, lsdiff, grepdiff, splitdiff)
#   - git
#
# Installation:
#   chmod +x scripts/git-smart-stage.sh
#   sudo apt install patchutils  # or: brew install patchutils
#
# Usage:
#   ./scripts/git-smart-stage.sh <command> [args...]
#
# Commands:
#   list-hunks <file>              - List all hunks in a file with their numbers
#   stage-hunks <file> <hunks>     - Stage specific hunks by number (e.g., "1,3-5")
#   stage-regex <file> <regex>     - Stage hunks matching a regex pattern
#   stage-lines <file> <range>     - Stage hunks containing specific line ranges
#   stage-new <file>               - Stage a new untracked file
#   stage-regex-all <regex> <glob> - Stage hunks matching regex across multiple files
#   analyze <file>                 - Analyze and describe each hunk (JSON output)
#   split-hunks <file>             - Split file changes into individual patch files
#
# Options:
#   --dry-run                      - Preview what would be staged without staging
#
# Examples:
#   ./git-smart-stage.sh list-hunks src/services/user_service.py
#   ./git-smart-stage.sh stage-hunks src/handlers/auth.go 1,3
#   ./git-smart-stage.sh stage-hunks path/to/file 1,3 --dry-run
#   ./git-smart-stage.sh stage-hunks path/to/file 2 --fine
#   ./git-smart-stage.sh stage-regex src/UserService.java "validation"
#   ./git-smart-stage.sh stage-new src/new_module.rb
#   ./git-smart-stage.sh stage-regex-all "validate" "src/**/*"
#   ./git-smart-stage.sh analyze path/to/file

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
TEMP_DIR=""
KEEP_TEMP=false
DRY_RUN=false
FINE_GRAINED=false
SKIP_FILES=("pr.md" "summary.md" "learn.md" "review.codex.md")
SKIP_PREFIXES=("superpowers/")

# Colors for output - only use if connected to a terminal
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

# Check dependencies
require_tools() {
    local missing=()

    for tool in "$@"; do
        if ! command -v "$tool" &> /dev/null; then
            case "$tool" in
                filterdiff|grepdiff)
                    missing+=("$tool (patchutils)")
                    ;;
                *)
                    missing+=("$tool")
                    ;;
            esac
        fi
    done

    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Error: Missing required tools:${NC}" >&2
        for tool in "${missing[@]}"; do
            echo "  - $tool" >&2
        done
        echo "" >&2
        echo "Install patchutils:" >&2
        echo "  Ubuntu/Debian: sudo apt install patchutils" >&2
        echo "  Fedora/RHEL:   sudo dnf install patchutils" >&2
        echo "  macOS:         brew install patchutils" >&2
        exit 1
    fi
}

require_command_deps() {
    local command="$1"

    require_tools git

    case "$command" in
        stage-hunks|stage-lines|split-hunks)
            require_tools filterdiff
            ;;
        stage-regex|stage-regex-all)
            require_tools grepdiff
            ;;
    esac
}

# Ensure we're in a git repository
ensure_git_repo() {
    if ! git rev-parse --git-dir &> /dev/null; then
        echo -e "${RED}Error: Not in a git repository${NC}" >&2
        exit 1
    fi
}

# Check if file exists (in working tree or git history)
check_file_exists() {
    local file="$1"

    # Check if it's a tracked file with changes
    if git ls-files --error-unmatch -- "$file" &> /dev/null; then
        return 0
    fi

    # Check if it's an untracked file that exists
    if [ -f "$file" ]; then
        return 0
    fi

    echo -e "${RED}Error: File '$file' not found${NC}" >&2
    echo "The file does not exist in the working directory or git history." >&2
    exit 1
}

# Create temp directory for patches
setup_temp() {
    if [ -z "$TEMP_DIR" ]; then
        TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/git-smart-stage.XXXXXX")"
    fi
}

# Generate a file diff. Fine-grained mode uses zero context so nearby edits
# become separate hunks when possible.
write_file_diff() {
    local file="$1"
    local output="$2"

    if [ "$FINE_GRAINED" = true ]; then
        git diff -U0 -- "$file" > "$output"
    else
        git diff -- "$file" > "$output"
    fi
}

git_diff_file() {
    local file="$1"

    if [ "$FINE_GRAINED" = true ]; then
        git diff -U0 -- "$file" 2>/dev/null
    else
        git diff -- "$file" 2>/dev/null
    fi
}

git_apply_cached_check() {
    local patch_file="$1"

    if [ "$FINE_GRAINED" = true ]; then
        git apply --cached --unidiff-zero --check "$patch_file"
    else
        git apply --cached --check "$patch_file"
    fi
}

git_apply_cached() {
    local patch_file="$1"

    if [ "$FINE_GRAINED" = true ]; then
        git apply --cached --unidiff-zero "$patch_file"
    else
        git apply --cached "$patch_file"
    fi
}

matches_glob() {
    local file="$1"
    local pattern="$2"

    if [[ "$file" == $pattern ]]; then
        return 0
    fi

    # Treat path/**/* as matching both path/file and path/nested/file.
    # Bash's pattern matching does not match the direct-child case for that form.
    while [[ "$pattern" == *"/**/"* ]]; do
        pattern="${pattern/\/**\//\/}"
        if [[ "$file" == $pattern ]]; then
            return 0
        fi
    done

    return 1
}

# Cleanup temp files
cleanup() {
    if [ "$KEEP_TEMP" = false ] && [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

# Trap cleanup on exit
trap cleanup EXIT

# JSON escape a string
json_escape() {
    local str="$1"
    # Escape backslashes, double quotes, and control characters
    str="${str//\\/\\\\}"
    str="${str//\"/\\\"}"
    str="${str//$'\n'/\\n}"
    str="${str//$'\r'/\\r}"
    str="${str//$'\t'/\\t}"
    echo "$str"
}

# Normalize repository-relative paths so policy checks cannot be bypassed.
normalize_file_path() {
    local input="$1"
    local normalized=""
    local part
    local parts=()

    if [[ "$input" == /* ]] || [[ "$input" =~ ^[A-Za-z]:[\\/] ]]; then
        echo -e "${RED}Error: Absolute paths are not allowed${NC}" >&2
        return 1
    fi

    IFS='/' read -r -a parts <<< "$input"
    for part in "${parts[@]}"; do
        case "$part" in
            ""|.)
                continue
                ;;
            ..)
                echo -e "${RED}Error: Parent traversal is not allowed${NC}" >&2
                return 1
                ;;
            *)
                if [ -n "$normalized" ]; then
                    normalized="$normalized/$part"
                else
                    normalized="$part"
                fi
                ;;
        esac
    done

    if [ -z "$normalized" ]; then
        echo -e "${RED}Error: File path is empty${NC}" >&2
        return 1
    fi

    printf '%s\n' "$normalized"
}

# Files used as agent scratchpads should never be staged by this helper.
ensure_stage_allowed() {
    local file
    file="$(normalize_file_path "$1")" || return 1

    for skipped in "${SKIP_FILES[@]}"; do
        if [ "$file" = "$skipped" ]; then
            echo -e "${RED}Error: '$file' is on the never-stage list${NC}" >&2
            return 1
        fi
    done

    for skipped_prefix in "${SKIP_PREFIXES[@]}"; do
        if [[ "$file" == "$skipped_prefix"* ]]; then
            echo -e "${RED}Error: '$file' is under a never-stage directory${NC}" >&2
            return 1
        fi
    done

    return 0
}

# List all hunks in a file with descriptions
list_hunks() {
    local file="$1"

    check_file_exists "$file"

    local diff_output
    diff_output=$(git_diff_file "$file")

    if [ -z "$diff_output" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    echo -e "${BLUE}Hunks in '$file':${NC}"
    echo "=================================================="

    # Count total hunks
    local total_hunks
    total_hunks=$(echo "$diff_output" | grep -c '^@@' || echo "0")

    echo -e "${GREEN}Total hunks: $total_hunks${NC}"
    echo ""

    # Show each hunk with number
    local hunk_num=0
    local in_hunk=false
    local hunk_header=""
    local hunk_preview=""
    local line_count=0
    local max_preview_lines=5

    while IFS= read -r line; do
        if [[ "$line" =~ ^@@.*@@(.*)$ ]]; then
            # Print previous hunk if exists
            if [ $hunk_num -gt 0 ]; then
                echo -e "${YELLOW}Hunk #$hunk_num:${NC} $hunk_header"
                echo "$hunk_preview"
                echo ""
            fi

            hunk_num=$((hunk_num + 1))
            hunk_header="${BASH_REMATCH[1]}"
            hunk_preview=""
            line_count=0
            in_hunk=true
        elif [ "$in_hunk" = true ] && [ $line_count -lt $max_preview_lines ]; then
            if [[ "$line" =~ ^[\+\-] ]]; then
                hunk_preview+="$line"$'\n'
                line_count=$((line_count + 1))
            fi
        fi
    done <<< "$diff_output"

    # Print last hunk
    if [ $hunk_num -gt 0 ]; then
        echo -e "${YELLOW}Hunk #$hunk_num:${NC} $hunk_header"
        echo "$hunk_preview"
    fi
}

# Stage specific hunks by number
stage_hunks() {
    local file="$1"
    local hunks="$2"

    ensure_stage_allowed "$file" || exit 1
    check_file_exists "$file"
    setup_temp

    local patch_file="$TEMP_DIR/full.patch"
    local filtered_file="$TEMP_DIR/filtered.patch"

    # Generate full diff
    write_file_diff "$file" "$patch_file"

    if [ ! -s "$patch_file" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    # Extract specific hunks using filterdiff
    # --hunks accepts: 1,3,5 or 1-3 or 1,3-5,7
    if ! filterdiff --hunks="$hunks" "$patch_file" > "$filtered_file" 2>/dev/null; then
        echo -e "${RED}Error: Failed to filter hunks. Valid range: --hunks=$hunks${NC}" >&2
        exit 1
    fi

    if [ ! -s "$filtered_file" ]; then
        echo -e "${RED}Error: No hunks matched the pattern '$hunks'${NC}" >&2
        exit 1
    fi

    # Dry-run mode: just show what would be staged
    if [ "$DRY_RUN" = true ]; then
        echo -e "${BLUE}[DRY-RUN] Would stage hunks [$hunks] from '$file':${NC}"
        echo ""
        cat "$filtered_file"
        return 0
    fi

    # Validate the patch (must use --cached to check against index, not working tree)
    if ! git_apply_cached_check "$filtered_file" 2>/dev/null; then
        echo -e "${RED}Error: Patch validation failed. The hunks may have conflicts.${NC}" >&2
        echo -e "${YELLOW}Tip: Inspect 'git diff --cached -- <file>' and stage hunks in order from top to bottom.${NC}" >&2
        cat "$filtered_file"
        exit 1
    fi

    # Apply to staging area
    if git_apply_cached "$filtered_file"; then
        echo -e "${GREEN}Successfully staged hunks [$hunks] from '$file'${NC}"
        echo ""
        echo -e "${BLUE}Staged changes:${NC}"
        git diff --cached -- "$file" | head -30
    else
        echo -e "${RED}Error: Failed to apply patch to staging area${NC}" >&2
        exit 1
    fi
}

# Stage hunks matching a regex pattern
stage_regex() {
    local file="$1"
    local regex="$2"

    ensure_stage_allowed "$file" || exit 1
    check_file_exists "$file"
    setup_temp

    local patch_file="$TEMP_DIR/full.patch"
    local filtered_file="$TEMP_DIR/filtered.patch"

    # Generate full diff
    write_file_diff "$file" "$patch_file"

    if [ ! -s "$patch_file" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    # Use grepdiff to find hunks matching the pattern, then extract them
    if ! grepdiff "$regex" --output-matching=hunk "$patch_file" > "$filtered_file" 2>/dev/null; then
        echo -e "${RED}Error: grepdiff failed for pattern '$regex'${NC}" >&2
        exit 1
    fi

    if [ ! -s "$filtered_file" ]; then
        echo -e "${YELLOW}No hunks matched the regex pattern '$regex'${NC}"
        return 0
    fi

    # Dry-run mode
    if [ "$DRY_RUN" = true ]; then
        echo -e "${BLUE}[DRY-RUN] Would stage hunks matching '$regex' from '$file':${NC}"
        echo ""
        cat "$filtered_file"
        return 0
    fi

    # Validate the patch (must use --cached to check against index)
    if ! git_apply_cached_check "$filtered_file" 2>/dev/null; then
        echo -e "${RED}Error: Patch validation failed${NC}" >&2
        exit 1
    fi

    # Apply to staging area
    if git_apply_cached "$filtered_file"; then
        echo -e "${GREEN}Successfully staged hunks matching '$regex' from '$file'${NC}"
        echo ""
        echo -e "${BLUE}Staged changes:${NC}"
        git diff --cached -- "$file" | head -30
    else
        echo -e "${RED}Error: Failed to apply patch${NC}" >&2
        exit 1
    fi
}

# Stage hunks containing specific line ranges from original file
stage_lines() {
    local file="$1"
    local range="$2"  # e.g., "10-20" or "10,20,30-40"

    ensure_stage_allowed "$file" || exit 1
    check_file_exists "$file"
    setup_temp

    local patch_file="$TEMP_DIR/full.patch"
    local filtered_file="$TEMP_DIR/filtered.patch"

    # Generate full diff
    write_file_diff "$file" "$patch_file"

    if [ ! -s "$patch_file" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    # Use filterdiff --lines to select hunks affecting specific line ranges
    if ! filterdiff --lines="$range" "$patch_file" > "$filtered_file" 2>/dev/null; then
        echo -e "${RED}Error: filterdiff failed for lines '$range'${NC}" >&2
        exit 1
    fi

    if [ ! -s "$filtered_file" ]; then
        echo -e "${YELLOW}No hunks affect lines in range '$range'${NC}"
        return 0
    fi

    # Dry-run mode
    if [ "$DRY_RUN" = true ]; then
        echo -e "${BLUE}[DRY-RUN] Would stage hunks affecting lines [$range] from '$file':${NC}"
        echo ""
        cat "$filtered_file"
        return 0
    fi

    # Validate and apply (must use --cached to check against index)
    if git_apply_cached_check "$filtered_file" 2>/dev/null && git_apply_cached "$filtered_file"; then
        echo -e "${GREEN}Successfully staged hunks affecting lines [$range] from '$file'${NC}"
    else
        echo -e "${RED}Error: Failed to apply patch${NC}" >&2
        exit 1
    fi
}

# Stage a new untracked file
stage_new() {
    local file
    file="$(normalize_file_path "$1")" || exit 1

    ensure_stage_allowed "$file" || exit 1

    if [ ! -f "$file" ]; then
        echo -e "${RED}Error: File '$file' not found${NC}" >&2
        exit 1
    fi

    # Check if file is untracked
    if git ls-files --error-unmatch -- "$file" &> /dev/null 2>&1; then
        echo -e "${YELLOW}File '$file' is already tracked. Use other staging commands instead.${NC}"
        return 0
    fi

    # Dry-run mode
    if [ "$DRY_RUN" = true ]; then
        echo -e "${BLUE}[DRY-RUN] Would stage new file '$file'${NC}"
        return 0
    fi

    # Stage the new file
    if git add -- "$file"; then
        echo -e "${GREEN}Successfully staged new file '$file'${NC}"
    else
        echo -e "${RED}Error: Failed to stage file${NC}" >&2
        exit 1
    fi
}

# Stage hunks matching a regex across multiple files
stage_regex_all() {
    local regex="$1"
    local glob_pattern="$2"

    setup_temp

    local staged_count=0
    local skipped_count=0
    local matched_count=0

    while IFS= read -r -d '' file; do
        if [ -z "$file" ]; then
            continue
        fi

        if ! matches_glob "$file" "$glob_pattern"; then
            continue
        fi

        matched_count=$((matched_count + 1))

        if ! ensure_stage_allowed "$file"; then
            skipped_count=$((skipped_count + 1))
            continue
        fi

        local safe_name
        safe_name="${file//[^A-Za-z0-9._-]/_}"
        local patch_file="$TEMP_DIR/full-$safe_name.patch"
        local filtered_file="$TEMP_DIR/filtered-$safe_name.patch"

        # Generate full diff
        write_file_diff "$file" "$patch_file"

        if [ ! -s "$patch_file" ]; then
            continue
        fi

        # Use grepdiff to find hunks matching the pattern
        if grepdiff "$regex" --output-matching=hunk "$patch_file" > "$filtered_file" 2>/dev/null && [ -s "$filtered_file" ]; then

            # Dry-run mode
            if [ "$DRY_RUN" = true ]; then
                echo -e "${BLUE}[DRY-RUN] Would stage hunks matching '$regex' from '$file'${NC}"
                skipped_count=$((skipped_count + 1))
                continue
            fi

            # Validate and apply
            if git_apply_cached_check "$filtered_file" 2>/dev/null && git_apply_cached "$filtered_file"; then
                echo -e "${GREEN}Staged hunks from '$file'${NC}"
                staged_count=$((staged_count + 1))
            else
                echo -e "${YELLOW}Skipped '$file' (patch conflict)${NC}"
                skipped_count=$((skipped_count + 1))
            fi
        fi
    done < <(git diff --name-only -z)

    if [ "$matched_count" -eq 0 ]; then
        echo -e "${YELLOW}No files with unstaged changes match pattern '$glob_pattern'${NC}"
        return 0
    fi

    if [ "$DRY_RUN" = true ]; then
        echo ""
        echo -e "${BLUE}[DRY-RUN] Would stage from $skipped_count files${NC}"
    else
        echo ""
        echo -e "${GREEN}Staged hunks from $staged_count files${NC}"
        if [ $skipped_count -gt 0 ]; then
            echo -e "${YELLOW}Skipped $skipped_count files${NC}"
        fi
    fi
}

# Analyze hunks and provide descriptions for AI to understand
analyze() {
    local file="$1"

    check_file_exists "$file"

    local diff_output
    diff_output=$(git_diff_file "$file")

    if [ -z "$diff_output" ]; then
        echo '{"file": "'"$(json_escape "$file")"'", "hunks": [], "total_hunks": 0}'
        return 0
    fi

    # Count hunks
    local total_hunks
    total_hunks=$(echo "$diff_output" | grep -c '^@@' || echo "0")

    echo "{"
    echo "  \"file\": \"$(json_escape "$file")\","
    echo "  \"total_hunks\": $total_hunks,"
    echo "  \"hunks\": ["

    local hunk_num=0
    local first_hunk=true

    while IFS= read -r line; do
        if [[ "$line" =~ ^@@\ -([0-9]+),?([0-9]*)\ \+([0-9]+),?([0-9]*)\ @@(.*)$ ]]; then
            if [ "$first_hunk" = false ]; then
                echo "    },"
            fi
            first_hunk=false
            hunk_num=$((hunk_num + 1))

            local old_start="${BASH_REMATCH[1]}"
            local old_count="${BASH_REMATCH[2]:-1}"
            local new_start="${BASH_REMATCH[3]}"
            local new_count="${BASH_REMATCH[4]:-1}"
            local context="${BASH_REMATCH[5]}"

            echo "    {"
            echo "      \"number\": $hunk_num,"
            echo "      \"old_line\": $old_start,"
            echo "      \"old_count\": $old_count,"
            echo "      \"new_line\": $new_start,"
            echo "      \"new_count\": $new_count,"
            echo "      \"context\": \"$(json_escape "$context")\""
        fi
    done <<< "$diff_output"

    if [ "$first_hunk" = false ]; then
        echo "    }"
    fi

    echo "  ]"
    echo "}"
}

# Show full diff with hunk numbers annotated
show_diff() {
    local file="$1"

    check_file_exists "$file"

    local diff_output
    diff_output=$(git_diff_file "$file")

    if [ -z "$diff_output" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    local hunk_num=0

    while IFS= read -r line; do
        if [[ "$line" =~ ^@@.*@@ ]]; then
            hunk_num=$((hunk_num + 1))
            echo ""
            echo -e "${YELLOW}========== HUNK #$hunk_num ==========${NC}"
        fi

        if [[ "$line" =~ ^\+ ]]; then
            echo -e "${GREEN}$line${NC}"
        elif [[ "$line" =~ ^\- ]]; then
            echo -e "${RED}$line${NC}"
        else
            echo "$line"
        fi
    done <<< "$diff_output"
}

# Split file changes into separate patches by analyzing content
split_hunks() {
    local file="$1"

    check_file_exists "$file"
    setup_temp
    KEEP_TEMP=true

    local patch_file="$TEMP_DIR/full.patch"

    # Generate full diff
    write_file_diff "$file" "$patch_file"

    if [ ! -s "$patch_file" ]; then
        echo -e "${YELLOW}No unstaged changes in '$file'${NC}"
        return 0
    fi

    # Count hunks
    local total_hunks
    total_hunks=$(grep -c '^@@' "$patch_file" || echo "0")

    echo -e "${BLUE}Splitting $total_hunks hunks from '$file' into individual patch files:${NC}"

    # Create individual patch file for each hunk
    for i in $(seq 1 "$total_hunks"); do
        local hunk_file="$TEMP_DIR/hunk-$i.patch"
        filterdiff --hunks="$i" "$patch_file" > "$hunk_file"
        echo "  Created: $hunk_file"
    done

    echo ""
    echo -e "${GREEN}Patch files created in $TEMP_DIR/${NC}"
    echo ""
    echo "Usage:"
    echo "  # Stage hunk 1:"
    if [ "$FINE_GRAINED" = true ]; then
        echo "  git apply --cached --unidiff-zero $TEMP_DIR/hunk-1.patch"
    else
        echo "  git apply --cached $TEMP_DIR/hunk-1.patch"
    fi
    echo ""
    echo "  # Stage hunks 1 and 3:"
    if [ "$FINE_GRAINED" = true ]; then
        echo "  cat $TEMP_DIR/hunk-{1,3}.patch | git apply --cached --unidiff-zero"
    else
        echo "  cat $TEMP_DIR/hunk-{1,3}.patch | git apply --cached"
    fi
}

# Show staging status for all modified files with hunk counts
status() {
    echo -e "${BLUE}Partial Staging Status${NC}"
    echo "========================================"

    # Get all files with unstaged changes
    local files
    files=$(git diff --name-only 2>/dev/null)

    if [ -z "$files" ]; then
        echo -e "${GREEN}No unstaged changes.${NC}"

        # Check if there are staged changes
        local staged_files
        staged_files=$(git diff --cached --name-only 2>/dev/null)
        if [ -n "$staged_files" ]; then
            echo ""
            echo -e "${YELLOW}Staged files ready to commit:${NC}"
            echo "$staged_files" | while read -r f; do
                echo "  - $f"
            done
        fi
        return 0
    fi

    echo ""
    echo -e "${YELLOW}Files with unstaged changes:${NC}"
    echo ""

    while IFS= read -r file; do
        local hunk_count
        hunk_count=$(git diff -- "$file" 2>/dev/null | grep -c '^@@' || echo "0")

        local staged_hunk_count=0
        if git diff --cached --quiet -- "$file" 2>/dev/null; then
            staged_hunk_count=0
        else
            staged_hunk_count=$(git diff --cached -- "$file" 2>/dev/null | grep -c '^@@' || echo "0")
        fi

        if [ "$staged_hunk_count" -gt 0 ]; then
            echo -e "  ${GREEN}$file${NC} - ${YELLOW}$hunk_count unstaged${NC}, ${GREEN}$staged_hunk_count staged${NC}"
        else
            echo -e "  $file - ${YELLOW}$hunk_count hunk(s)${NC}"
        fi
    done <<< "$files"

    # Also show untracked files
    local untracked_files
    untracked_files=$(git ls-files --others --exclude-standard 2>/dev/null)
    if [ -n "$untracked_files" ]; then
        echo ""
        echo -e "${YELLOW}Untracked files (use 'stage-new <file>' to stage):${NC}"
        echo "$untracked_files" | head -10 | while read -r f; do
            echo "  ?? $f"
        done
        local untracked_count
        untracked_count=$(echo "$untracked_files" | wc -l)
        if [ "$untracked_count" -gt 10 ]; then
            echo "  ... and $((untracked_count - 10)) more"
        fi
    fi

    echo ""
    echo -e "${BLUE}Tip:${NC} Use 'list-hunks <file>' to see hunk details"
}

# Quick summary of all changes in JSON format for AI parsing
summary() {
    echo "{"
    echo "  \"unstaged_files\": ["

    local files
    files=$(git diff --name-only 2>/dev/null)
    local first=true

    if [ -n "$files" ]; then
        while IFS= read -r file; do
            local hunk_count
            hunk_count=$(git diff -- "$file" 2>/dev/null | grep -c '^@@' || echo "0")

            if [ "$first" = true ]; then
                first=false
            else
                echo ","
            fi
            echo -n "    {\"file\": \"$(json_escape "$file")\", \"hunks\": $hunk_count}"
        done <<< "$files"
    fi

    echo ""
    echo "  ],"
    echo "  \"staged_files\": ["

    local staged_files
    staged_files=$(git diff --cached --name-only 2>/dev/null)
    first=true

    if [ -n "$staged_files" ]; then
        while IFS= read -r file; do
            local hunk_count
            hunk_count=$(git diff --cached -- "$file" 2>/dev/null | grep -c '^@@' || echo "0")

            if [ "$first" = true ]; then
                first=false
            else
                echo ","
            fi
            echo -n "    {\"file\": \"$(json_escape "$file")\", \"hunks\": $hunk_count}"
        done <<< "$staged_files"
    fi

    echo ""
    echo "  ],"
    echo "  \"untracked_files\": ["

    local untracked_files
    untracked_files=$(git ls-files --others --exclude-standard 2>/dev/null)
    first=true

    if [ -n "$untracked_files" ]; then
        while IFS= read -r file; do
            if [ "$first" = true ]; then
                first=false
            else
                echo ","
            fi
            echo -n "    \"$(json_escape "$file")\""
        done <<< "$untracked_files"
    fi

    echo ""
    echo "  ]"
    echo "}"
}

# Print usage
usage() {
    echo "git-smart-stage.sh - Non-interactive partial staging for AI agents"
    echo ""
    echo "Usage: $SCRIPT_NAME <command> [args...] [--dry-run]"
    echo ""
    echo "Commands:"
    echo "  status                           Show staging status for all files"
    echo "  summary                          Output all file changes as JSON"
    echo "  list-hunks <file>                List all hunks with preview"
    echo "  show-diff <file>                 Show diff with hunk numbers annotated"
    echo "  stage-hunks <file> <hunks>       Stage specific hunks (e.g., '1,3-5')"
    echo "  stage-regex <file> <regex>       Stage hunks matching regex"
    echo "  stage-lines <file> <range>       Stage hunks affecting line range"
    echo "  stage-new <file>                 Stage a new untracked file"
    echo "  stage-regex-all <regex> <glob>   Stage regex matches across multiple files"
    echo "  analyze <file>                   Output hunk info as JSON"
    echo "  split-hunks <file>               Split into individual patch files"
    echo ""
    echo "Options:"
    echo "  --dry-run                        Preview what would be staged without staging"
    echo "  --fine                           Use zero-context hunks for nearby edits"
    echo ""
    echo "Examples:"
    echo "  $SCRIPT_NAME status"
    echo "  $SCRIPT_NAME list-hunks src/services/user_service.py"
    echo "  $SCRIPT_NAME stage-hunks src/handlers/auth.go 1,3"
    echo "  $SCRIPT_NAME stage-hunks path/to/file 1,3 --dry-run"
    echo "  $SCRIPT_NAME list-hunks path/to/file --fine"
    echo "  $SCRIPT_NAME stage-hunks path/to/file 2 --fine"
    echo "  $SCRIPT_NAME stage-regex src/UserService.java 'validate'"
    echo "  $SCRIPT_NAME stage-lines path/to/file 10-50"
    echo "  $SCRIPT_NAME stage-new src/new_module.rb"
    echo "  $SCRIPT_NAME stage-regex-all 'validate' 'src/**/*'"
    echo ""
    echo "Requirements:"
    echo "  - patchutils (install: sudo apt install patchutils)"
    echo "  - git"
}

# Main
main() {
    if [ $# -lt 1 ]; then
        usage
        exit 1
    fi

    # Parse options without losing argument boundaries.
    local args=()
    local parse_options=true
    while [ $# -gt 0 ]; do
        if [ "$parse_options" = false ]; then
            args+=("$1")
            shift
            continue
        fi

        case "$1" in
            --)
                parse_options=false
                ;;
            --dry-run)
                DRY_RUN=true
                ;;
            --fine|--zero-context)
                FINE_GRAINED=true
                ;;
            *)
                args+=("$1")
                ;;
        esac
        shift
    done
    set -- "${args[@]}"

    if [ $# -lt 1 ]; then
        usage
        exit 1
    fi

    local command="$1"
    shift || true

    case "$command" in
        help|--help|-h)
            usage
            return 0
            ;;
    esac

    require_command_deps "$command"
    ensure_git_repo

    case "$command" in
        status)
            status
            ;;
        summary)
            summary
            ;;
        list-hunks)
            if [ $# -lt 1 ]; then
                echo -e "${RED}Error: Missing file argument${NC}" >&2
                echo "Usage: $SCRIPT_NAME list-hunks <file>" >&2
                exit 1
            fi
            list_hunks "$1"
            ;;
        show-diff)
            if [ $# -lt 1 ]; then
                echo -e "${RED}Error: Missing file argument${NC}" >&2
                exit 1
            fi
            show_diff "$1"
            ;;
        stage-hunks)
            if [ $# -lt 2 ]; then
                echo -e "${RED}Error: Missing arguments${NC}" >&2
                echo "Usage: $SCRIPT_NAME stage-hunks <file> <hunks> [--dry-run]" >&2
                echo "Example: $SCRIPT_NAME stage-hunks path/to/file 1,3-5" >&2
                exit 1
            fi
            stage_hunks "$1" "$2"
            ;;
        stage-regex)
            if [ $# -lt 2 ]; then
                echo -e "${RED}Error: Missing arguments${NC}" >&2
                echo "Usage: $SCRIPT_NAME stage-regex <file> <regex> [--dry-run]" >&2
                exit 1
            fi
            stage_regex "$1" "$2"
            ;;
        stage-lines)
            if [ $# -lt 2 ]; then
                echo -e "${RED}Error: Missing arguments${NC}" >&2
                echo "Usage: $SCRIPT_NAME stage-lines <file> <range> [--dry-run]" >&2
                exit 1
            fi
            stage_lines "$1" "$2"
            ;;
        stage-new)
            if [ $# -lt 1 ]; then
                echo -e "${RED}Error: Missing file argument${NC}" >&2
                echo "Usage: $SCRIPT_NAME stage-new <file> [--dry-run]" >&2
                exit 1
            fi
            stage_new "$1"
            ;;
        stage-regex-all)
            if [ $# -lt 2 ]; then
                echo -e "${RED}Error: Missing arguments${NC}" >&2
                echo "Usage: $SCRIPT_NAME stage-regex-all <regex> <glob> [--dry-run]" >&2
                echo "Example: $SCRIPT_NAME stage-regex-all 'validate' 'src/**/*'" >&2
                exit 1
            fi
            stage_regex_all "$1" "$2"
            ;;
        analyze)
            if [ $# -lt 1 ]; then
                echo -e "${RED}Error: Missing file argument${NC}" >&2
                exit 1
            fi
            analyze "$1"
            ;;
        split-hunks)
            if [ $# -lt 1 ]; then
                echo -e "${RED}Error: Missing file argument${NC}" >&2
                exit 1
            fi
            split_hunks "$1"
            ;;
        *)
            echo -e "${RED}Error: Unknown command '$command'${NC}" >&2
            usage
            exit 1
            ;;
    esac
}

main "$@"
