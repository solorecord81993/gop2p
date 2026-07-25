# GoP2P UI Refresh

คัดลอกไฟล์ทั้งหมดไปที่ root ของ repo แล้วรัน:

```bash
node apply-ui-refresh.js
npm test
npm start
```

ตรวจ `/`, `/director.html`, `/live.html` แล้ว commit:

```bash
git add public/index.html public/director.html public/live.html public/ui-light.css apply-ui-refresh.js
git commit -m "Refresh UI with light responsive layout"
git push
```

สิ่งที่เปลี่ยน:
- Light Theme
- Responsive mobile/tablet/desktop
- Desktop game layout 2 คอลัมน์
- Mobile และ landscape layout
- Responsive Director grid
- Light broadcast studio
- ไม่แตะ logic เกมหรือ i18n เดิม
