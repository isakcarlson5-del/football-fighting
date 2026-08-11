#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
generated_root="/Users/isakcarlson/.codex/generated_images/019fe7f6-7a56-72f1-95b9-0c88c0d34509"
chroma_tool="/Users/isakcarlson/.codex/skills/.system/imagegen/scripts/remove_chroma_key.py"
runstrip_tmp="$(mktemp -d)"

cleanup_runstrip_tmp() {
  find "$runstrip_tmp" -depth -delete
}
trap cleanup_runstrip_tmp EXIT

process_strip() {
  local category="$1"
  local asset_id="$2"
  local generated_file="$3"
  local source_dir="$project_root/art-source/$category"
  local output_dir="$project_root/public/art/$category"
  local source_file="$source_dir/${asset_id}-run6-src.png"
  local alpha_file="$runstrip_tmp/${asset_id}-alpha.png"
  local output_file="$output_dir/${asset_id}-run.png"
  local frame_files=()

  mkdir -p "$source_dir" "$output_dir"
  cp "$generated_root/$generated_file" "$source_file"

  python3 "$chroma_tool" \
    --input "$source_file" \
    --out "$alpha_file" \
    --auto-key border \
    --soft-matte \
    --transparent-threshold 12 \
    --opaque-threshold 220 \
    --edge-feather 0.35 \
    --despill \
    --force

  for frame_idx in 0 1 2 3 4 5; do
    local frame_file="$runstrip_tmp/${asset_id}-${frame_idx}.png"
    local crop_x=$((frame_idx * 362))
    magick "$alpha_file" \
      -crop "362x724+${crop_x}+0" +repage \
      -trim +repage \
      -resize '228x298>' \
      -gravity south \
      -background none \
      -extent 256x320 \
      "$frame_file"
    frame_files+=("$frame_file")
  done

  magick "${frame_files[@]}" +append -strip -define png:compression-level=9 "$output_file"
  printf '%s %s\n' "$asset_id" "$(identify -format '%wx%h %[channels]' "$output_file")"
}

process_strip enemies invader exec-0a5593dc-073b-4828-aad7-39ac8e145aba.png
process_strip enemies sprinter exec-83b98334-d8ed-4e46-a376-e8c117fe2e7b.png
process_strip enemies lobber exec-6cdbbd03-6a66-418b-b096-25510ba178bf.png
process_strip enemies flare exec-4958ebda-a17b-4b6a-9f52-1e0f0e91b6d0.png
process_strip enemies flag exec-05859086-e88a-4a8f-9bcc-26618145a20a.png
process_strip enemies foam exec-9c55973e-4873-4877-8a92-21ff37fa1ba6.png
process_strip enemies steward exec-b1fed734-c0c2-404c-b80a-8f3d6183b95c.png
process_strip enemies drummer exec-382a5806-ec86-4215-967b-3da5a4a9f0eb.png
process_strip enemies vuvuzela exec-d53b4b0f-f3ef-4e97-bd7d-b8b8484f4189.png
process_strip enemies mascot exec-2f044130-0e4c-4e17-877b-55e197725bea.png
process_strip enemies banner exec-0718499e-bcfb-4fe0-b3f7-a6fb87eeab2e.png
process_strip enemies paparazzo exec-c3db5eaf-5063-4963-9ab0-ca1c36ec388f.png
process_strip enemies chant exec-5e49b61c-7bbd-4996-b9e3-5f9486353837.png
process_strip enemies bull exec-760f380b-960e-42b7-8af4-00bd99370199.png
process_strip enemies drone exec-63089623-96ff-4e62-8997-6177d361bbe9.png
process_strip enemies boss-drumboss exec-b0252ed9-e8d5-4b38-82c3-d116d10b7b01.png
process_strip enemies boss-official exec-984abd59-6e12-41fa-9462-b4efb8e29005.png
process_strip enemies boss-captain exec-0fafc973-d50c-42a2-9748-818e0518b84b.png
process_strip players messi exec-f637f0ee-70d9-47f7-8ec6-6faf15bf835b.png
process_strip players ronaldo exec-d5690964-9352-42bf-badc-fb107bac52a7.png
process_strip players neymar exec-1db53330-2b30-4ebe-87f0-98cc9909821d.png
process_strip players yamal exec-6e82754d-2893-48bb-abb1-e8be1d223709.png
