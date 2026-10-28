# Smart Mobility model results

This folder contains the training outputs and evaluation plots for the project models. The application copies the detector and converted distance model into `frontend/public/models/` for browser inference.

## Model files

- `runs/kitti_yolov8n/weights/best.onnx` — trained YOLOv8n detector, 640 × 640 input, 8 KITTI classes. The app copy is `frontend/public/models/yolov8n_kitti.onnx`.
- `runs/kitti_yolov8n/weights/best.pt` and `last.pt` — PyTorch detector checkpoints.
- `distance_model.joblib` — scikit-learn GradientBoostingRegressor training artifact.
- `../frontend/public/models/distance_model.onnx` — browser-ready ONNX conversion supplied for this project.
- `distance_data.csv` — object-level distance training data with KITTI LiDAR distances.

## Data and reported results

- Detector data: KITTI, 5,985 training images and 1,496 validation images; class order is car, van, truck, pedestrian, person_sitting, cyclist, tram, misc.
- Distance data: 39,368 KITTI objects with LiDAR distance labels. Distance feature order is label_id, normalized box width, normalized box height, normalized center x, normalized center y, and width/height aspect ratio. Distance label IDs are car=0, cyclist=1, pedestrian=2, tram=3, truck=4, van=5.
- Reported detector validation: precision 0.884, recall 0.766, mAP50 0.856, mAP50–95 0.593; approximately 2.7 ms inference on a T4 GPU.
- Reported distance validation: MAE 1.54 m and RMSE 2.36 m, compared with 16.34 m and 19.25 m for the earlier pinhole formula.

Metrics above are the supplied training results; the browser integration does not reproduce the KITTI validation evaluation.
