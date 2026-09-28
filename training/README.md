# Panalo Pipes online training pilot

## PP-TRN-WLD-001

The source deck is `ppt/pp-trn-wld-001/source.pptx`. This Draft Rev 1 deck contains 20 actual slides. Its 20 web slides and `manifest.json` are in the same folder. The manifest pairs slides 1–19 with a plain-language summary and a knowledge check; slide 20 has the final theory assessment below the slide. The web page requests one slide image only when the learner opens that slide. The library and module landing page do not download the deck or slide images.

Browsers cannot display individual `.pptx` slides reliably. The source PowerPoint is retained in GitHub, while the web page uses rendered WebP slides. The current images are about 1920 × 1080 and 75–275 KB each. The repository copy has its footer numbering corrected from the supplied file's inconsistent `/24` and `23/24` labels to the actual 20-slide count. Large embedded RGB artwork was recompressed as high-quality JPEG within the PowerPoint to keep the source file uploadable; the supplied original remains untouched.

### Updating the deck

1. Replace `ppt/pp-trn-wld-001/source.pptx` with the reviewed deck.
2. Update `manifest.json` so every slide has its matching title, key points and question. Write the answer and feedback for each question. Review the final exam too.
3. Change the manifest revision when the reviewed learning content changes, then commit both files. The `render-training-slides` workflow checks the slide count and questions, renders and commits the web images, and requests a Pages build. It fails rather than publishing a slide count that does not match the checks. A changed revision clears saved progress and theory results in the learner's browser.
4. Check the live page on desktop and phone, including the full-size image link and the final result after a reload.
5. Obtain technical, WHS, IMS and client approval before changing the module status from draft or assigning it as controlled training.

To render locally, install LibreOffice, PyMuPDF and Pillow, then run:

```bash
python3 training/scripts/render_ppt.py training/ppt/pp-trn-wld-001
```

### Records and release status

This remains **Draft Rev 1**. The learner's progress and theory result are stored in that browser. A provisional JSON result can be downloaded for IMS administration; the worker ID is entered only at download time and is not saved by the site. The result is editable and cannot serve as an authoritative controlled record. Practical verification and task authorisation must be recorded in an approved IMS system. The linked practical checklist is a draft handoff aid.

Before formal issue, insert the approved procedure/JSA and applicable SWMS and permit references, required PPE, client emergency arrangements, WPS/WPQ/ITP and form IDs. Slide 6's 10 m combustible clearance and 30-minute fire-watch examples need verification against the approved site permit and risk assessment; do not treat those numbers as universal rules. Keep confidential employee and controlled client records out of this public repository. An authenticated training record service is still required for formal deployment.

Public reference points for the technical review: [WorkSafe Victoria on welding](https://www.worksafe.vic.gov.au/welding), [controlling exposure to welding fumes](https://www.worksafe.vic.gov.au/controlling-exposure-welding-fumes), [SWMS for high-risk construction work](https://www.worksafe.vic.gov.au/safe-work-method-statements-swms), and [safe use of angle grinders](https://www.worksafe.vic.gov.au/resources/safe-use-angle-grinders). These do not replace the approved Panalo Pipes and host-site documents.
