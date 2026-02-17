# 📊 Excel Test Report with Embedded GIFs Guide

**Date:** February 12, 2026  
**Purpose:** Embed Cypress test execution videos (as GIFs) into Excel for visual test documentation

---

## 🎥 **What You Have**

### **Test Videos (MP4):**

- Location: `cypress/videos/`
- Format: `FR-020-###-PASSED.mp4` or `FR-020-###-FAILED.mp4`
- Features: Automatically named with test ID and pass/fail status

### **Test GIFs (Enhanced):**

- Location: `cypress/videos/`
- Format: `FR-020-###-PASSED-ENHANCED.gif` or `FR-020-###-FAILED-ENHANCED.gif`
- Features:
  - **1.5× slower playback** (easier to see actions)
  - **Test ID overlay** (top-left corner)
  - **Status badge** (green for PASSED, red for FAILED)
  - **Test description** (yellow text)
  - **Optimized for Excel** (800px wide, ~2-3MB each)

---

## 🔧 **Step 1: Convert All Videos to Enhanced GIFs**

### **Option A: Run the Batch Script**

1. Double-click `convert-videos-enhanced.bat` in the project root
2. Wait for conversion (about 30-60 seconds per video)
3. All GIFs will be created in `cypress/videos/`

### **Option B: Manual Conversion (Single Video)**

```bash
cd cypress/videos

# For PASSED test
ffmpeg -i FR-020-001-PASSED.mp4 -vf "setpts=1.5*PTS,fps=8,scale=800:-1:flags=lanczos,drawtext=text='Test\: FR-020-001':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=10:y=10,drawtext=text='Status\: PASSED':fontsize=32:fontcolor=green:box=1:boxcolor=black@0.8:boxborderw=5:x=10:y=50,drawtext=text='Search Input Display':fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=5:x=10:y=100,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 FR-020-001-PASSED-ENHANCED.gif -y

# For FAILED test
ffmpeg -i FR-020-008-FAILED.mp4 -vf "setpts=1.5*PTS,fps=8,scale=800:-1:flags=lanczos,drawtext=text='Test\: FR-020-008':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=10:y=10,drawtext=text='Status\: FAILED':fontsize=32:fontcolor=red:box=1:boxcolor=black@0.8:boxborderw=5:x=10:y=50,drawtext=text='Clear Search Functionality':fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=5:x=10:y=100,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 FR-020-008-FAILED-ENHANCED.gif -y
```

---

## 📋 **Step 2: Create Excel Test Report**

### **Method 1: Insert as Image (Recommended)**

1. **Open Excel** and create your test report structure:

   ```
   | Test ID    | Description              | Status  | Video     |
   |------------|--------------------------|---------|-----------|
   | FR-020-001 | Search Input Display     | PASSED  | [GIF]     |
   | FR-020-002 | Search Icon Display      | PASSED  | [GIF]     |
   | FR-020-008 | Clear Search             | FAILED  | [GIF]     |
   ```

2. **Insert GIF:**
   - Click on the cell where you want the GIF
   - Go to: **Insert** → **Pictures** → **This Device**
   - Navigate to `cypress/videos/`
   - Select `FR-020-001-PASSED-ENHANCED.gif`
   - Click **Insert**

3. **Resize GIF:**
   - Right-click the GIF → **Size and Properties**
   - Set width to **400-600 pixels** (fits nicely in Excel)
   - Lock aspect ratio ✅
   - Position: **Move and size with cells**

4. **The GIF will animate in Excel!** 🎉

---

### **Method 2: Hyperlink to GIF File**

If file size is a concern (Excel gets too large):

1. **Create hyperlink:**

   ```
   | Test ID    | Video Link                          |
   |------------|-------------------------------------|
   | FR-020-001 | =HYPERLINK("videos/FR-020-001.gif") |
   ```

2. **User clicks link → GIF opens in browser/viewer**

---

### **Method 3: Embed as ActiveX Control (Advanced)**

For interactive playback control:

1. **Enable Developer Tab:**
   - File → Options → Customize Ribbon
   - Check "Developer" ✅

2. **Insert ActiveX Control:**
   - Developer → Insert → More Controls
   - Select "Microsoft Web Browser"
   - Draw control on sheet
   - Right-click → Properties
   - Set `NavigateURL` to full path of GIF

---

## 📊 **Sample Excel Report Structure**

### **Test Execution Summary Sheet:**

| Column A    | Column B              | Column C   | Column D     | Column E       | Column F      |
| ----------- | --------------------- | ---------- | ------------ | -------------- | ------------- |
| **Test ID** | **Test Description**  | **Status** | **Duration** | **Screenshot** | **Video GIF** |
| FR-020-001  | Search Input Display  | ✅ PASSED  | 18s          | [img]          | [gif]         |
| FR-020-002  | Search Icon Display   | ✅ PASSED  | 17s          | [img]          | [gif]         |
| FR-020-008  | Clear Search          | ❌ FAILED  | 75s          | [img]          | [gif]         |
| FR-020-013  | Reset Button Function | ❌ FAILED  | 47s          | [img]          | [gif]         |

### **Formatting Tips:**

- **Row Height:** 300-400 pixels (to fit GIFs)
- **Column Width:** 100 pixels for videos
- **Conditional Formatting:**
  - PASSED cells: Green background
  - FAILED cells: Red background
- **Freeze Panes:** Freeze header row for scrolling

---

## 🎨 **Customization Options**

### **Slower/Faster Videos:**

Change `setpts` value in FFmpeg command:

- **Slower:** `setpts=2.0*PTS` (2× slower)
- **Normal:** `setpts=1.0*PTS` (original speed)
- **Faster:** `setpts=0.5*PTS` (2× faster)

### **Different Text Overlays:**

Edit `drawtext` parameters:

```bash
# Change text
drawtext=text='My Custom Text'

# Change color
fontcolor=blue    # Options: red, green, blue, yellow, white, black

# Change font size
fontsize=28

# Change position
x=10:y=10         # Top-left
x=(w-text_w-10):y=10  # Top-right
x=10:y=(h-text_h-10)  # Bottom-left
```

### **Add Test Step Annotations:**

```bash
# Add multiple text overlays (step-by-step)
drawtext=text='Step 1\: Login':fontsize=20:fontcolor=white:x=10:y=150
drawtext=text='Step 2\: Navigate to Contacts':fontsize=20:fontcolor=white:x=10:y=180
drawtext=text='Step 3\: Perform Search':fontsize=20:fontcolor=white:x=10:y=210
```

---

## 📦 **File Size Optimization**

### **Current Sizes:**

- MP4 video: ~600KB (1262×624, 25fps)
- Standard GIF: ~2.4MB (800×396, 10fps)
- Enhanced GIF: ~2.5MB (800×396, 8fps, with text)

### **Reduce GIF Size:**

**Option 1: Lower resolution**

```bash
scale=600:-1    # Instead of 800:-1 (25% smaller)
```

**Option 2: Reduce frame rate**

```bash
fps=6           # Instead of fps=8 (25% smaller)
```

**Option 3: Shorten duration (trim)**

```bash
-ss 00:00:02 -t 00:00:10    # Start at 2s, take 10s
```

**Example (smaller GIF):**

```bash
ffmpeg -i FR-020-001-PASSED.mp4 -ss 00:00:02 -t 00:00:10 -vf "setpts=1.5*PTS,fps=6,scale=600:-1:flags=lanczos,drawtext=text='FR-020-001 PASSED':fontsize=20:fontcolor=green:box=1:boxcolor=black@0.8:boxborderw=5:x=10:y=10,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 FR-020-001-SMALL.gif -y
```

Result: ~1MB (50% smaller!)

---

## 🔗 **Embedding GIFs: Limitations & Workarounds**

### **Excel Limitations:**

- ❌ **Excel Online (web):** GIFs show as static images (first frame only)
- ✅ **Excel Desktop:** GIFs animate fully
- ⚠️ **File size:** Large workbooks (>50MB) may slow down

### **Workarounds:**

1. **Use thumbnails + hyperlinks:**
   - Insert static screenshot (small file)
   - Hyperlink to full GIF video
   - Best for large reports (50+ tests)

2. **Separate video folder:**
   - Keep Excel file small
   - Store GIFs in shared folder/network drive
   - Use relative paths in hyperlinks

3. **Cloud storage links:**
   - Upload GIFs to OneDrive/Google Drive
   - Embed shareable links in Excel
   - Always accessible, no file size impact

---

## 📝 **Example Excel Formulas**

### **Auto-generate video filename:**

```excel
=CONCATENATE("cypress/videos/", A2, "-", C2, "-ENHANCED.gif")
```

Where:

- A2 = Test ID (e.g., FR-020-001)
- C2 = Status (e.g., PASSED)

### **Conditional formatting (status colors):**

```excel
# For PASSED cells (green)
=C2="PASSED"
Format: Background = Green, Font = White

# For FAILED cells (red)
=C2="FAILED"
Format: Background = Red, Font = White
```

### **Count pass/fail:**

```excel
# Total PASSED
=COUNTIF(C:C,"PASSED")

# Total FAILED
=COUNTIF(C:C,"FAILED")

# Pass Rate
=COUNTIF(C:C,"PASSED")/COUNTA(C:C)*100 & "%"
```

---

## 🎯 **Quick Start Checklist**

- [x] Run Cypress tests (videos saved to `cypress/videos/`)
- [x] Videos named with test ID + PASSED/FAILED
- [ ] Run `convert-videos-enhanced.bat` to create GIFs
- [ ] Open Excel and create test report structure
- [ ] Insert GIFs: **Insert → Pictures → Select GIF**
- [ ] Resize GIFs to fit cells (400-600px width)
- [ ] Set row height (300-400px)
- [ ] Add conditional formatting (green=PASSED, red=FAILED)
- [ ] Save Excel file
- [ ] Share with team! 🎉

---

## 💡 **Pro Tips**

1. **Keep it organized:** Create separate sheets for different FRs
   - Sheet 1: "FR-020 Customer Search"
   - Sheet 2: "FR-001 Login Tests"
   - Sheet 3: "Summary Dashboard"

2. **Use data validation:** Dropdown for Status column
   - List: `PASSED, FAILED, SKIPPED, BLOCKED`

3. **Add filters:** Enable AutoFilter on header row
   - Quickly filter by status, test ID, or duration

4. **Dashboard sheet:** Create summary with charts
   - Pie chart: Pass vs Fail ratio
   - Bar chart: Test duration comparison
   - Table: Failed tests list with video links

5. **Protect workbook:** Lock cells except for comments/notes
   - Review → Protect Sheet
   - Allow: "Select unlocked cells" only

---

## 📞 **Troubleshooting**

### **GIF doesn't animate in Excel:**

- ✅ **Check:** Using Excel Desktop (not Excel Online)
- ✅ **Check:** File format is `.gif` (not `.mp4`)
- ✅ **Try:** Re-insert the GIF

### **GIF file too large:**

- ✅ **Reduce resolution:** `scale=600:-1` or `scale=400:-1`
- ✅ **Reduce fps:** `fps=6` or `fps=5`
- ✅ **Trim duration:** `-t 00:00:10` (take only 10 seconds)

### **FFmpeg font errors:**

- ⚠️ **Warning:** "Fontconfig error" is harmless
- ✅ **Ignore:** Text overlays still work
- ✅ **Fix (optional):** Install fonts or use system fonts

### **Excel file too large (>100MB):**

- ✅ **Solution 1:** Use hyperlinks instead of embedded images
- ✅ **Solution 2:** Store GIFs externally (OneDrive, network drive)
- ✅ **Solution 3:** Use smaller GIFs (see optimization section)

---

## 🎉 **Result**

You now have:

- ✅ **Automated test video recording** (Cypress)
- ✅ **Auto-named videos** (Test ID + PASS/FAIL)
- ✅ **Enhanced GIFs** (slower, with annotations)
- ✅ **Excel-ready documentation** (visual test reports)
- ✅ **Shareable test evidence** (embedded or linked)

**Perfect for:**

- 📊 Test execution reports
- 📧 Bug reports (with video proof)
- 👥 Stakeholder demos
- 📚 Test documentation
- ✅ Quality assurance reviews

---

**Created:** February 12, 2026  
**Tools:** Cypress, FFmpeg, Excel  
**Status:** ✅ Ready to use
