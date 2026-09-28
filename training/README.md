# Panalo Pipes online training pilot

## PP-TRN-WLD-001

The source deck is `ppt/pp-trn-wld-001/source.pptx`. Its 15 web slides and `manifest.json` are in the same folder. The manifest pairs every slide with a plain-language summary and a knowledge check. Slide 15 has the final assessment. The web page requests one slide image only when the learner opens that slide. The library and module landing page do not download the deck or slide images.

Browsers cannot display individual `.pptx` slides reliably. The source PowerPoint is retained in GitHub, while the web page uses rendered WebP slides. The current images are 1920 × 1080 and about 175–310 KB each. Slides 4 and 7 use the full original artwork so no hazard or PPE callout is cropped.

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

This remains **Draft Rev 0**. The learner's progress and theory result are stored in that browser. A provisional JSON result can be downloaded for IMS administration; the worker ID is entered only at download time and is not saved by the site. The result is editable and cannot serve as an authoritative controlled record. Practical verification and task authorisation must be recorded in an approved IMS system. The linked practical checklist is a draft handoff aid.

Before formal issue, insert the approved procedure/JSA and applicable SWMS and permit references, required PPE, client emergency arrangements, WPS/WPQ/ITP and form IDs. Keep confidential employee and controlled client records out of this public repository. An authenticated training record service is still required for formal deployment.
